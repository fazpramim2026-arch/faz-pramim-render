const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const axios = require("axios");
const https = require("https");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

if (!admin.apps.length) {
  const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (serviceAccountBase64) {
    const serviceAccount = JSON.parse(
      Buffer.from(serviceAccountBase64, "base64").toString("utf8")
    );
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } else if (serviceAccountJson) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(serviceAccountJson)),
    });
  } else {
    admin.initializeApp();
  }
}

const db = admin.firestore();

function agora() {
  return new Date();
}

function normalizarId(valor) {
  return String(valor || "").trim();
}

function normalizarDescricao(valor) {
  return String(valor || "Pagamento Faz Pra Mim").trim().slice(0, 140);
}

function pegarBearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || "";
  if (!header.startsWith("Bearer ")) return "";
  return header.replace("Bearer ", "").trim();
}

async function verificarUsuarioPeloToken(req) {
  const idToken = pegarBearerToken(req);

  if (!idToken) {
    const erro = new Error("Token de autenticacao nao enviado.");
    erro.status = 401;
    throw erro;
  }

  return admin.auth().verifyIdToken(idToken);
}

async function carregarPedidoAutorizado(pedidoId, decoded, papelEsperado) {
  const pedidoRef = db.collection("pedidos").doc(String(pedidoId));
  const pedidoDoc = await pedidoRef.get();

  if (!pedidoDoc.exists) {
    const erro = new Error("Pedido nao encontrado.");
    erro.status = 404;
    throw erro;
  }

  const pedido = pedidoDoc.data() || {};
  const uid = decoded.uid;
  const clienteAutorizado = pedido.clienteId === uid;
  const prestadorAutorizado =
    pedido.prestadorId === uid || pedido.aceitoPor === uid;

  if (
    (papelEsperado === "cliente" && !clienteAutorizado) ||
    (papelEsperado === "prestador" && !prestadorAutorizado) ||
    (papelEsperado === "participante" &&
      !clienteAutorizado &&
      !prestadorAutorizado)
  ) {
    const erro = new Error("Usuario sem permissao para este pedido.");
    erro.status = 403;
    throw erro;
  }

  return { pedidoRef, pedido };
}

function valorDoPedido(pedido) {
  const candidatos = [
    pedido.valorTotal,
    pedido.valorServico,
    pedido.valor,
    pedido.preco,
  ];
  const valor = Number(candidatos.find((item) => Number(item) > 0) || 0);

  if (!Number.isFinite(valor) || valor <= 0) {
    const erro = new Error("Pedido sem valor valido.");
    erro.status = 400;
    throw erro;
  }

  return valor;
}

function calcularValores(valor) {
  const valorTotal = Number(valor);
  const comissaoApp = Number((valorTotal * 0.1).toFixed(2));
  const valorPrestador = Number((valorTotal - comissaoApp).toFixed(2));

  return { valorTotal, comissaoApp, valorPrestador };
}

function txidDoPedido(pedidoId) {
  return crypto
    .createHash("sha256")
    .update(`fazpramim-${String(pedidoId)}`)
    .digest("hex")
    .slice(0, 32);
}

function idEnvioDoPedido(pedidoId) {
  return crypto
    .createHash("sha256")
    .update(`repasse-fazpramim-${String(pedidoId)}`)
    .digest("hex")
    .slice(0, 35);
}

function somenteDinheiro(valor) {
  const numero = Number(valor || 0);

  if (!Number.isFinite(numero) || numero <= 0) {
    const erro = new Error("Valor Pix invalido.");
    erro.status = 400;
    throw erro;
  }

  return numero.toFixed(2);
}

function repassePixEfiConfirmado(envio) {
  const status = String(
    envio?.status || envio?.situacao || envio?.estado || ""
  )
    .trim()
    .toUpperCase();

  return [
    "CONCLUIDA",
    "CONCLUIDO",
    "EFETIVADA",
    "EFETIVADO",
    "LIQUIDADA",
    "LIQUIDADO",
    "REALIZADA",
    "REALIZADO",
    "SUCESSO",
    "EXECUTADA",
    "EXECUTADO",
  ].includes(status);
}

async function consultarRepassePixEfi(idEnvio) {
  try {
    return await efiRequest("GET", `/v2/gn/pix/${idEnvio}`);
  } catch (e) {
    console.error("Erro ao consultar repasse Pix Efi:", {
      idEnvio,
      erro: erroPublicoEfi(e),
    });
    return null;
  }
}

function comprovanteRepassePixEfi({
  idEnvio,
  envio,
  consultaRepasse,
  valorPrestador,
}) {
  const origem = consultaRepasse || envio || {};

  return {
    idEnvio,
    endToEndId: origem.endToEndId || origem.e2eId || "",
    horario: origem.horario || origem.criadoEm || origem.data || "",
    valor: somenteDinheiro(valorPrestador),
    favorecido: origem.favorecido || envio?.favorecido || null,
    dadosEfi: envio || null,
    consultaEfi: consultaRepasse || null,
  };
}

async function marcarRepassePixEfiConcluido({
  pedidoRef,
  pedidoId,
  prestadorId,
  idEnvio,
  envio,
  consultaRepasse,
  valorPrestador,
  valorTotal,
  comissaoApp,
  chavePixTrabalhador,
  notificar = true,
}) {
  const comprovante = comprovanteRepassePixEfi({
    idEnvio,
    envio,
    consultaRepasse,
    valorPrestador,
  });

  await pedidoRef.set(
    {
      pagamentoStatus: "repasse_concluido",
      repassePrestadorStatus: "concluido",
      repassePrestadorMensagem:
        "Servico confirmado. Repasse enviado com sucesso ao trabalhador.",
      repassePrestadorDadosEfi: envio || null,
      repassePrestadorConsultaEfi: consultaRepasse || null,
      repassePrestadorComprovante: comprovante,
      repassePrestadorEm: agora(),
      dinheiroRetidoAteConfirmacao: false,
      atualizadoEm: agora(),
    },
    { merge: true }
  );

  await db.collection("repasses").doc(idEnvio).set(
    {
      pedidoId,
      prestadorId,
      chavePixTrabalhador,
      valorTotal,
      comissaoApp,
      valorPrestador,
      provedor: "efi",
      idEnvio,
      status: "concluido",
      dadosEfi: envio || null,
      consultaEfi: consultaRepasse || null,
      comprovante,
      concluidoEm: agora(),
      atualizadoEm: agora(),
    },
    { merge: true }
  );

  if (notificar && prestadorId) {
    await criarNotificacao(
      prestadorId,
      "Repasse enviado",
      `Seu repasse de R$ ${Number(valorPrestador)
        .toFixed(2)
        .replace(".", ",")} foi enviado via Pix.`,
      "repasse_enviado",
      pedidoId
    );
  }

  return comprovante;
}

async function reconciliarRepassePixEfiPendente(pedidoId, dadosPedido = null) {
  const pedidoRef = db.collection("pedidos").doc(String(pedidoId));
  const pedidoSnap = dadosPedido ? null : await pedidoRef.get();
  const pedido = dadosPedido || (pedidoSnap.exists ? pedidoSnap.data() || {} : {});
  const idEnvio = String(pedido.repassePrestadorIdEnvio || "").trim();

  if (!idEnvio || pedido.repassePrestadorStatus !== "processando") {
    return { concluido: false, idEnvio };
  }

  const repasseSnap = await db.collection("repasses").doc(idEnvio).get();
  const repasse = repasseSnap.exists ? repasseSnap.data() || {} : {};
  const consultaRepasse = await consultarRepassePixEfi(idEnvio);

  if (!repassePixEfiConfirmado(consultaRepasse)) {
    await db.collection("repasses").doc(idEnvio).set(
      {
        pedidoId: String(pedidoId),
        provedor: "efi",
        idEnvio,
        status: "processando",
        consultaEfi: consultaRepasse || null,
        ultimaConsultaEm: agora(),
        atualizadoEm: agora(),
      },
      { merge: true }
    );

    return { concluido: false, idEnvio, consultaRepasse };
  }

  const prestadorId = String(
    repasse.prestadorId || pedido.prestadorId || pedido.aceitoPor || ""
  );
  const valorTotal = Number(
    repasse.valorTotal || pedido.valorTotal || valorDoPedido(pedido)
  );
  const comissaoApp = Number(
    repasse.comissaoApp || pedido.comissaoApp || (valorTotal * 0.1).toFixed(2)
  );
  const valorPrestador = Number(
    repasse.valorPrestador ||
      pedido.valorPrestador ||
      (valorTotal - comissaoApp).toFixed(2)
  );

  const comprovante = await marcarRepassePixEfiConcluido({
    pedidoRef,
    pedidoId: String(pedidoId),
    prestadorId,
    idEnvio,
    envio: repasse.dadosEfi || pedido.repassePrestadorDadosEfi || null,
    consultaRepasse,
    valorPrestador,
    valorTotal,
    comissaoApp,
    chavePixTrabalhador:
      repasse.chavePixTrabalhador || pedido.prestadorPix || "",
  });

  return { concluido: true, idEnvio, consultaRepasse, comprovante };
}

let reconciliandoRepassesEfi = false;

async function processarRepassesPixEfiPendentes(limite = 20) {
  if (reconciliandoRepassesEfi) {
    return { processados: 0, concluidos: 0, ignorado: true };
  }

  reconciliandoRepassesEfi = true;

  try {
    const snap = await db
      .collection("repasses")
      .where("status", "==", "processando")
      .limit(limite)
      .get();

    let concluidos = 0;

    for (const doc of snap.docs) {
      const repasse = doc.data() || {};
      if (repasse.provedor && repasse.provedor !== "efi") continue;
      const pedidoId = String(repasse.pedidoId || "").trim();
      if (!pedidoId) continue;

      try {
        const resultado = await reconciliarRepassePixEfiPendente(pedidoId);
        if (resultado.concluido) concluidos += 1;
      } catch (e) {
        console.error("Erro ao reconciliar repasse Pix Efi pendente:", {
          pedidoId,
          idEnvio: doc.id,
          erro: erroPublicoEfi(e),
        });
      }
    }

    return { processados: snap.size, concluidos };
  } finally {
    reconciliandoRepassesEfi = false;
  }
}

function detalhesErroEfi(erro) {
  if (erro?.response) {
    return {
      message: erro.message,
      status: erro.response.status,
      data: erro.response.data,
    };
  }

  try {
    return JSON.parse(erro.message);
  } catch (_) {
    return { message: erro.message };
  }
}

function erroPublicoEfi(erro) {
  const detalhes = detalhesErroEfi(erro);
  return {
    mensagem: detalhes.message || erro.message,
    status: detalhes.status || null,
    data: detalhes.data || null,
  };
}

function pedidoTemPagamentoConfirmadoParaRepasse(pedido) {
  if (pedido.pago !== true) return false;

  const status = String(pedido.pagamentoStatus || "").trim();
  const statusPermitidos = new Set([
    "pago_bloqueado",
    "aguardando_confirmacao_cliente",
    "repasse_erro",
    "liberado_para_repasse",
  ]);

  return statusPermitidos.has(status) || Boolean(pedido.pagamentoConfirmadoEm);
}

function getEfiConfig() {
  return {
    baseUrl: process.env.EFI_BASE_URL || "https://pix.api.efipay.com.br",
    clientId: process.env.EFI_CLIENT_ID,
    clientSecret: process.env.EFI_CLIENT_SECRET,
    certPath: process.env.EFI_CERT_PATH || "./certs/efi_producao.p12",
    certBase64: process.env.EFI_CERT_BASE64,
    certPemPath: process.env.EFI_CERT_PEM_PATH,
    keyPemPath: process.env.EFI_KEY_PEM_PATH,
    certPemBase64: process.env.EFI_CERT_PEM_BASE64,
    keyPemBase64: process.env.EFI_KEY_PEM_BASE64,
    certPassphrase: process.env.EFI_CERT_PASSPHRASE || "",
    chavePixApp: process.env.EFI_CHAVE_PIX_APP,
    webhookPixUrl:
      process.env.EFI_WEBHOOK_PIX_URL ||
      "https://faz-pramim-render.onrender.com/webhookPixEfi",
  };
}

function validarEfiConfig() {
  const cfg = getEfiConfig();
  const faltando = [];

  if (!cfg.clientId) faltando.push("EFI_CLIENT_ID");
  if (!cfg.clientSecret) faltando.push("EFI_CLIENT_SECRET");
  const temP12 = cfg.certBase64 || fs.existsSync(cfg.certPath);
  const temPem =
    (cfg.certPemBase64 && cfg.keyPemBase64) ||
    (cfg.certPemPath &&
      cfg.keyPemPath &&
      fs.existsSync(cfg.certPemPath) &&
      fs.existsSync(cfg.keyPemPath));

  if (!temP12 && !temPem) {
    faltando.push(
      "EFI_CERT_BASE64/EFI_CERT_PATH ou EFI_CERT_PEM_BASE64+EFI_KEY_PEM_BASE64"
    );
  }

  if (faltando.length) {
    throw new Error(`Configuração Efí incompleta: ${faltando.join(", ")}`);
  }

  return cfg;
}

function efiAgent() {
  const cfg = validarEfiConfig();

  if (
    (cfg.certPemBase64 && cfg.keyPemBase64) ||
    (cfg.certPemPath && cfg.keyPemPath)
  ) {
    const cert = cfg.certPemBase64
      ? Buffer.from(cfg.certPemBase64, "base64").toString("utf8")
      : fs.readFileSync(cfg.certPemPath, "utf8");
    const key = cfg.keyPemBase64
      ? Buffer.from(cfg.keyPemBase64, "base64").toString("utf8")
      : fs.readFileSync(cfg.keyPemPath, "utf8");

    return new https.Agent({
      cert,
      key,
      passphrase: cfg.certPassphrase,
      keepAlive: true,
    });
  }

  const pfx = cfg.certBase64
    ? Buffer.from(cfg.certBase64, "base64")
    : fs.readFileSync(cfg.certPath);

  return new https.Agent({
    pfx,
    passphrase: cfg.certPassphrase,
    keepAlive: true,
  });
}

let tokenEfiCache = null;
let tokenEfiExpiraEm = 0;

async function obterTokenEfi() {
  const cfg = validarEfiConfig();

  if (tokenEfiCache && Date.now() < tokenEfiExpiraEm) {
    return tokenEfiCache;
  }

  const auth = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString(
    "base64"
  );

  console.log("Efí OAuth: solicitando token client_credentials.");

  const resposta = await axios({
    method: "POST",
    url: `${cfg.baseUrl}/oauth/token`,
    httpsAgent: efiAgent(),
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
      "Accept-Encoding": "identity",
    },
    data: { grant_type: "client_credentials" },
    validateStatus: () => true,
  });

  if (resposta.status < 200 || resposta.status >= 300) {
    console.error("Efí OAuth: falha ao obter token.", {
      status: resposta.status,
      data: resposta.data,
    });
    throw new Error(
      JSON.stringify({ status: resposta.status, data: resposta.data })
    );
  }

  tokenEfiCache = resposta.data.access_token;
  tokenEfiExpiraEm =
    Date.now() + (Number(resposta.data.expires_in || 3000) - 60) * 1000;

  return tokenEfiCache;
}

function exigirChavePixEfi(cfg) {
  if (!cfg.chavePixApp) {
    throw new Error("ConfiguraÃ§Ã£o EfÃ­ incompleta: EFI_CHAVE_PIX_APP");
  }
}

function urlWebhookPixEfiComIgnorar(url) {
  const webhookUrl = String(url || "").trim();

  if (!webhookUrl) {
    throw new Error("URL do webhook Pix EfÃ­ nÃ£o configurada");
  }

  if (/[?&]ignorar=/.test(webhookUrl)) {
    return webhookUrl;
  }

  return webhookUrl.includes("?")
    ? `${webhookUrl}&ignorar=`
    : `${webhookUrl}?ignorar=`;
}

async function efiRequest(method, path, data, extraHeaders = {}) {
  const cfg = validarEfiConfig();
  const token = await obterTokenEfi();

  console.log("Efí request:", {
    method,
    path,
    hasBody: data !== undefined && data !== null,
  });

  const resposta = await axios({
    method,
    url: `${cfg.baseUrl}${path}`,
    httpsAgent: efiAgent(),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept-Encoding": "identity",
      ...extraHeaders,
    },
    data,
    validateStatus: () => true,
  });

  if (resposta.status < 200 || resposta.status >= 300) {
    console.error("Efí request falhou:", {
      method,
      path,
      status: resposta.status,
      data: resposta.data,
    });
    throw new Error(
      JSON.stringify({
        status: resposta.status,
        data: resposta.data,
      })
    );
  }

  console.log("Efí request OK:", { method, path, status: resposta.status });
  return resposta.data;
}

async function criarNotificacao(userId, titulo, mensagem, tipo, pedidoId) {
  if (!userId) return;

  await db.collection("notificacoes").add({
    userId,
    titulo,
    mensagem,
    tipo,
    pedidoId: pedidoId || "",
    lida: false,
    criadoEm: agora(),
  });
}

app.post(["/criarPagamentoPix", "/criarPagamentoPixEfi"], async (req, res) => {
  try {
    const decoded = await verificarUsuarioPeloToken(req);
    const { pedidoId, valor, descricao, emailCliente } = req.body || {};
    const pedidoIdSeguro = normalizarId(pedidoId);

    if (!pedidoIdSeguro) {
      return res.status(400).json({ erro: "Informe pedidoId" });
    }

    const { pedido } = await carregarPedidoAutorizado(
      pedidoIdSeguro,
      decoded,
      "cliente"
    );
    const clienteIdSeguro = pedido.clienteId;
    const prestadorIdSeguro = pedido.prestadorId || pedido.aceitoPor;
    const emailSeguro = decoded.email || emailCliente || "";
    const valorBase = valorDoPedido(pedido);

    if (!prestadorIdSeguro) {
      return res.status(400).json({ erro: "Pedido sem trabalhador vinculado." });
    }

    if (valor && Math.abs(Number(valor) - valorBase) > 0.01) {
      return res
        .status(400)
        .json({ erro: "Valor informado nao confere com o pedido." });
    }

    const cfg = validarEfiConfig();
    exigirChavePixEfi(cfg);

    const { valorTotal, comissaoApp, valorPrestador } =
      calcularValores(valorBase);
    const txid = txidDoPedido(pedidoIdSeguro);
    const pagamentoRef = db.collection("pagamentos").doc(txid);
    const pagamentoExistente = await pagamentoRef.get();

    if (pagamentoExistente.exists) {
      const pagamento = pagamentoExistente.data() || {};
      if (pagamento.qrCode || pagamento.status === "CONCLUIDA") {
        console.log("Pix Efí já existia para o pedido; retornando dados salvos.", {
          pedidoId: pedidoIdSeguro,
          txid,
          status: pagamento.status,
        });
        return res.status(200).json({
          sucesso: true,
          provedor: "efi",
          pagamentoId: txid,
          txid,
          status: pagamento.status || "pending",
          valorTotal,
          comissaoApp,
          valorPrestador,
          qrCode: pagamento.qrCode || "",
          qrCodeBase64: pagamento.qrCodeBase64 || "",
          ticketUrl: pagamento.ticketUrl || "",
        });
      }
    }

    console.log("Criando cobrança Pix Efí.", {
      pedidoId: pedidoIdSeguro,
      txid,
      clienteId: clienteIdSeguro,
      prestadorId: prestadorIdSeguro,
      valorTotal,
    });

    const expiraEm = new Date(Date.now() + 5 * 60 * 1000);
    const cobranca = await efiRequest("PUT", `/v2/cob/${txid}`, {
      calendario: { expiracao: 300 },
      valor: { original: somenteDinheiro(valorTotal) },
      chave: cfg.chavePixApp,
      solicitacaoPagador: normalizarDescricao(descricao),
    });

    let qr = {};
    if (cobranca.loc && cobranca.loc.id) {
      qr = await efiRequest("GET", `/v2/loc/${cobranca.loc.id}/qrcode`);
    }

    await pagamentoRef.set(
      {
        provedor: "efi",
        txid,
        pedidoId: pedidoIdSeguro,
        clienteId: clienteIdSeguro,
        prestadorId: prestadorIdSeguro,
        emailCliente: emailSeguro,
        valorTotal,
        comissaoApp,
        valorPrestador,
        status: cobranca.status || "ATIVA",
        qrCode: qr.qrcode || "",
        qrCodeBase64: qr.imagemQrcode || "",
        ticketUrl: qr.linkVisualizacao || "",
        cobrancaEfi: cobranca,
        criadoEm: agora(),
        atualizadoEm: agora(),
        expiraEm,
      },
      { merge: true }
    );

    await db.collection("pedidos").doc(pedidoIdSeguro).set(
      {
        pagamentoId: txid,
        provedorPagamento: "efi",
        txidEfi: txid,
        pagamentoStatus: "pending",
        pago: false,
        status: "aguardando_pagamento",
        clienteId: clienteIdSeguro,
        prestadorId: prestadorIdSeguro,
        valorTotal,
        comissaoApp,
        valorPrestador,
        chatLiberado: false,
        localizacaoLiberada: false,
        dinheiroRetidoAteConfirmacao: true,
        atualizadoEm: agora(),
        pagamentoExpiraEm: expiraEm,
      },
      { merge: true }
    );

    return res.status(200).json({
      sucesso: true,
      provedor: "efi",
      pagamentoId: txid,
      txid,
      status: "pending",
      valorTotal,
      comissaoApp,
      valorPrestador,
      qrCode: qr.qrcode || "",
      qrCodeBase64: qr.imagemQrcode || "",
      ticketUrl: qr.linkVisualizacao || "",
    });
  } catch (e) {
    console.error("Erro ao criar Pix Efí:", e);
    const status = Number(e.status || 500);
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      erro: "Erro ao criar Pix Efí",
      detalhes: e.message,
    });
  }
});

app.post("/cadastrarWebhookPixEfi", async (req, res) => {
  try {
    const cfg = validarEfiConfig();
    exigirChavePixEfi(cfg);

    const webhookUrl = urlWebhookPixEfiComIgnorar(
      req.body?.webhookUrl || cfg.webhookPixUrl
    );

    const resultado = await efiRequest(
      "PUT",
      `/v2/webhook/${encodeURIComponent(cfg.chavePixApp)}`,
      { webhookUrl },
      { "x-skip-mtls-checking": "true" }
    );

    return res.status(200).json({
      sucesso: true,
      webhookUrl,
      resultado,
    });
  } catch (e) {
    console.error("Erro ao cadastrar webhook Pix EfÃ­:", e);
    return res.status(500).json({
      sucesso: false,
      erro: "Erro ao cadastrar webhook Pix EfÃ­",
      detalhes: e.message,
    });
  }
});

async function localizarPagamentoEfi(txid, pedidoIdInformado) {
  const txidSeguro = String(txid || "").trim();
  const pagamentoRef = db.collection("pagamentos").doc(txidSeguro);
  const pagamentoDoc = await pagamentoRef.get();

  if (pagamentoDoc.exists) {
    const pagamento = pagamentoDoc.data() || {};
    return {
      pagamentoRef,
      pagamento,
      pedidoId: pagamento.pedidoId || pedidoIdInformado || "",
    };
  }

  if (pedidoIdInformado) {
    return {
      pagamentoRef,
      pagamento: { pedidoId: pedidoIdInformado },
      pedidoId: pedidoIdInformado,
    };
  }

  const pedidoSnap = await db
    .collection("pedidos")
    .where("txidEfi", "==", txidSeguro)
    .limit(1)
    .get();

  if (pedidoSnap.empty) {
    return { pagamentoRef, pagamento: {}, pedidoId: "" };
  }

  const pedidoDoc = pedidoSnap.docs[0];
  const pedido = pedidoDoc.data() || {};

  return {
    pagamentoRef,
    pagamento: {
      pedidoId: pedidoDoc.id,
      clienteId: pedido.clienteId || "",
      prestadorId: pedido.prestadorId || pedido.aceitoPor || "",
      valorTotal: pedido.valorTotal || pedido.valorServico || 0,
      comissaoApp: pedido.comissaoApp || 0,
      valorPrestador: pedido.valorPrestador || 0,
    },
    pedidoId: pedidoDoc.id,
  };
}

async function confirmarPagamentoEfi(txid, pedidoIdInformado) {
  const txidSeguro = String(txid || "").trim();

  if (!txidSeguro) {
    return { confirmado: false, erro: "txid ausente" };
  }

  const cobrancaAtual = await efiRequest("GET", `/v2/cob/${txidSeguro}`);
  const statusEfi = String(cobrancaAtual.status || "");
  const { pagamentoRef, pagamento, pedidoId } = await localizarPagamentoEfi(
    txidSeguro,
    pedidoIdInformado
  );

  if (statusEfi !== "CONCLUIDA") {
    await pagamentoRef.set({
      ...pagamento,
      provedor: "efi",
      txid: txidSeguro,
      pedidoId: pedidoId || pedidoIdInformado || "",
      status: statusEfi,
      cobrancaEfiConfirmada: cobrancaAtual,
      atualizadoEm: agora(),
    }, { merge: true });

    return {
      confirmado: false,
      txid: txidSeguro,
      pedidoId: pedidoId || pedidoIdInformado || "",
      status: statusEfi,
    };
  }

  if (!pedidoId) {
    return {
      confirmado: false,
      txid: txidSeguro,
      status: statusEfi,
      erro: "Pagamento Efí sem pedidoId",
    };
  }

  await pagamentoRef.set({
    ...pagamento,
    provedor: "efi",
    txid: txidSeguro,
    pedidoId,
    status: "CONCLUIDA",
    pagamentoStatus: "pago_bloqueado",
    pago: true,
    cobrancaEfiConfirmada: cobrancaAtual,
    atualizadoEm: agora(),
  }, { merge: true });

  await db.collection("pedidos").doc(String(pedidoId)).set({
    pago: true,
    pagamentoStatus: "pago_bloqueado",
    status: "pago_aguardando_trabalhador",
    chatLiberado: false,
    localizacaoLiberada: false,
    dinheiroRetidoAteConfirmacao: true,
    pagamentoConfirmadoEm: agora(),
    atualizadoEm: agora(),
  }, { merge: true });

  return {
    confirmado: true,
    txid: txidSeguro,
    pedidoId,
    status: "CONCLUIDA",
    pagamentoStatus: "pago_bloqueado",
  };
}

app.post(["/webhookPixEfi", "/webhookPixEfi/pix"], async (req, res) => {
  try {
    const pixRecebidos = Array.isArray(req.body?.pix) ? req.body.pix : [];

    for (const pix of pixRecebidos) {
      const txid = String(pix.txid || "").trim();
      if (!txid) continue;

      const resultado = await confirmarPagamentoEfi(txid);

      if (!resultado.confirmado) {
        console.warn("Webhook Pix Efi ignorado; cobranca nao confirmada.", {
          txid,
          status: resultado.status || "",
          erro: resultado.erro || "",
        });
      }
    }

    return res.status(200).send("Webhook Pix Efi processado");
  } catch (e) {
    console.error("Erro webhook Pix Efi:", e);
    return res.status(200).send("Erro interno webhook Pix Efi");
  }
});

app.post("/verificarPagamentoManual", async (req, res) => {
  try {
    const { pagamentoId, txid, pedidoId } = req.body || {};
    const txidSeguro = String(txid || pagamentoId || "").trim();
    const pedidoIdSeguro = String(pedidoId || "").trim();

    if (!txidSeguro) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe pagamentoId ou txid",
      });
    }

    const resultado = await confirmarPagamentoEfi(txidSeguro, pedidoIdSeguro);

    if (resultado.erro) {
      return res.status(400).json({
        sucesso: false,
        ...resultado,
      });
    }

    return res.status(200).json({
      sucesso: true,
      pagamentoId: txidSeguro,
      ...resultado,
    });
  } catch (e) {
    console.error("Erro ao verificar pagamento Efí:", e);
    return res.status(500).json({
      sucesso: false,
      erro: "Erro ao verificar pagamento Efí",
      detalhes: e.message,
    });
  }
});

app.all("/processarRepassesPendentes", async (req, res) => {
  try {
    const segredoConfigurado = String(process.env.CRON_SECRET || "").trim();
    const segredoRecebido = String(
      req.headers["x-cron-secret"] || req.query?.secret || req.body?.secret || ""
    ).trim();

    if (segredoConfigurado && segredoRecebido !== segredoConfigurado) {
      return res.status(401).json({ erro: "Nao autorizado" });
    }

    const limite = Math.min(Number(req.body?.limite || req.query?.limite || 20), 50);
    const resultado = await processarRepassesPixEfiPendentes(limite);

    return res.status(200).json({ sucesso: true, ...resultado });
  } catch (e) {
    console.error("Erro ao processar repasses Pix Efi pendentes:", e);
    return res.status(500).json({
      sucesso: false,
      erro: "Erro ao processar repasses pendentes",
      detalhes: erroPublicoEfi(e),
    });
  }
});

app.post("/clienteConfirmouServico", async (req, res) => {
  const { pedidoId, clienteId } = req.body || {};
  const pedidoIdSeguro = normalizarId(pedidoId);
  let pedidoRef = null;
  let idEnvio = "";

  try {
    const decoded = await verificarUsuarioPeloToken(req);

    if (!pedidoIdSeguro || !clienteId) {
      return res.status(400).json({ erro: "Dados obrigatorios faltando" });
    }

    const carregado = await carregarPedidoAutorizado(
      pedidoIdSeguro,
      decoded,
      "cliente"
    );
    pedidoRef = carregado.pedidoRef;
    const pedido = carregado.pedido;
    const clienteIdSeguro = pedido.clienteId;

    if (clienteId && clienteId !== clienteIdSeguro) {
      return res.status(403).json({ erro: "Cliente incorreto" });
    }

    if (!pedidoTemPagamentoConfirmadoParaRepasse(pedido)) {
      return res.status(400).json({
        erro: "Pedido ainda nao possui pagamento Pix confirmado.",
      });
    }

    if (pedido.trabalhadorFinalizou !== true) {
      return res.status(400).json({
        erro: "Aguarde o trabalhador marcar que terminou o servico.",
      });
    }

    if (pedido.repassePrestadorStatus === "concluido") {
      return res.status(200).json({
        sucesso: true,
        mensagem:
          "Repasse ja concluido. O pagamento ao trabalhador foi confirmado.",
        idEnvio: pedido.repassePrestadorIdEnvio || "",
      });
    }

    if (pedido.repassePrestadorStatus === "processando") {
      idEnvio = String(pedido.repassePrestadorIdEnvio || "");
      const resultado = await reconciliarRepassePixEfiPendente(
        pedidoIdSeguro,
        pedido
      );

      if (resultado.concluido) {
        return res.status(200).json({
          sucesso: true,
          mensagem:
            "Servico confirmado. Repasse enviado com sucesso ao trabalhador.",
          idEnvio: resultado.idEnvio,
          comprovante: resultado.comprovante,
        });
      }

      return res.status(202).json({
        sucesso: true,
        status: "processando",
        mensagem:
          "Repasse Pix ja foi solicitado na Efi e sera confirmado automaticamente.",
        idEnvio: resultado.idEnvio || idEnvio,
      });
    }

    const prestadorId = pedido.prestadorId || pedido.aceitoPor || "";
    const prestadorDoc = prestadorId
      ? await db.collection("usuarios").doc(String(prestadorId)).get()
      : null;
    const prestador =
      prestadorDoc && prestadorDoc.exists ? prestadorDoc.data() || {} : {};
    const chavePixTrabalhador = String(
      pedido.prestadorPix ||
        prestador.pix ||
        prestador.chavePix ||
        prestador.chave_pix ||
        ""
    ).trim();

    if (!prestadorId) {
      return res.status(400).json({ erro: "Pedido sem trabalhador vinculado." });
    }

    if (!chavePixTrabalhador) {
      const erroSemPix = {
        message: "Trabalhador sem chave Pix cadastrada.",
        code: "TRABALHADOR_SEM_PIX",
      };
      await pedidoRef.set(
        {
          status: "concluido",
          pagamentoStatus: "repasse_erro",
          repassePrestadorStatus: "erro_sem_pix",
          repassePrestadorMensagem: erroSemPix.message,
          repassePrestadorErro: erroSemPix,
          dinheiroRetidoAteConfirmacao: true,
          clienteConfirmouServico: true,
          clienteConfirmouFinalizacao: true,
          clienteConfirmouEm: agora(),
          atualizadoEm: agora(),
        },
        { merge: true }
      );
      return res.status(400).json({ erro: erroSemPix.message });
    }

    const valorTotal = Number(pedido.valorTotal || valorDoPedido(pedido));
    const comissaoApp = Number(
      pedido.comissaoApp || (valorTotal * 0.1).toFixed(2)
    );
    const valorPrestador = Number(
      pedido.valorPrestador || (valorTotal - comissaoApp).toFixed(2)
    );

    if (!Number.isFinite(valorPrestador) || valorPrestador <= 0) {
      return res.status(400).json({ erro: "Valor do repasse invalido." });
    }

    const cfg = validarEfiConfig();
    exigirChavePixEfi(cfg);
    idEnvio = idEnvioDoPedido(pedidoIdSeguro);

    console.log("Cliente confirmou servico; preparando repasse Pix Efí.", {
      pedidoId: pedidoIdSeguro,
      clienteId: clienteIdSeguro,
      prestadorId,
      idEnvio,
      valorTotal,
      comissaoApp,
      valorPrestador,
    });

    await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(pedidoRef);
      const dados = snap.data() || {};

      if (dados.repassePrestadorStatus === "concluido") {
        throw new Error("REPASSE_JA_CONCLUIDO");
      }

      if (dados.repassePrestadorStatus === "processando") {
        throw new Error("REPASSE_EM_PROCESSAMENTO");
      }

      if (!pedidoTemPagamentoConfirmadoParaRepasse(dados)) {
        throw new Error("PAGAMENTO_NAO_BLOQUEADO");
      }

      if (dados.trabalhadorFinalizou !== true) {
        throw new Error("SERVICO_NAO_FINALIZADO_PELO_TRABALHADOR");
      }

      transaction.set(
        pedidoRef,
        {
          status: "concluido",
          pagamentoStatus: "repasse_processando",
          dinheiroRetidoAteConfirmacao: true,
          clienteConfirmouServico: true,
          clienteConfirmouFinalizacao: true,
          clienteConfirmouEm: agora(),
          valorTotal,
          comissaoApp,
          valorPrestador,
          repassePrestadorStatus: "processando",
          repassePrestadorIdEnvio: idEnvio,
          repassePrestadorSolicitadoEm: agora(),
          atualizadoEm: agora(),
        },
        { merge: true }
      );
    });

    await db.collection("repasses").doc(idEnvio).set(
      {
        pedidoId: pedidoIdSeguro,
        clienteId: clienteIdSeguro,
        prestadorId,
        chavePixTrabalhador,
        valorTotal,
        comissaoApp,
        valorPrestador,
        provedor: "efi",
        idEnvio,
        status: "processando",
        criadoEm: agora(),
        atualizadoEm: agora(),
      },
      { merge: true }
    );

    const envio = await efiRequest("PUT", `/v2/gn/pix/${idEnvio}`, {
      valor: somenteDinheiro(valorPrestador),
      pagador: {
        chave: cfg.chavePixApp,
        infoPagador: `Repasse Faz Pra Mim pedido ${pedidoIdSeguro}`.slice(
          0,
          140
        ),
      },
      favorecido: { chave: chavePixTrabalhador },
    });

    console.log("Resposta do repasse Pix Efi recebida.", {
      pedidoId: pedidoIdSeguro,
      idEnvio,
      endToEndId: envio.endToEndId || envio.e2eId || "",
      status: envio.status || envio.situacao || envio.estado || "",
    });

    const consultaRepasse = await consultarRepassePixEfi(idEnvio);
    const confirmacaoRepasse = consultaRepasse || envio;

    console.log("Consulta do repasse Pix Efi recebida.", {
      pedidoId: pedidoIdSeguro,
      idEnvio,
      endToEndId:
        confirmacaoRepasse.endToEndId || confirmacaoRepasse.e2eId || "",
      status:
        confirmacaoRepasse.status ||
        confirmacaoRepasse.situacao ||
        confirmacaoRepasse.estado ||
        "",
      valor: confirmacaoRepasse.valor || "",
    });

    if (!repassePixEfiConfirmado(confirmacaoRepasse)) {
      const mensagemProcessando =
        "Servico confirmado. Repasse Pix solicitado na Efi, mas ainda nao confirmado no extrato.";

      console.warn("Repasse Pix Efi ainda nao confirmado.", {
        pedidoId: pedidoIdSeguro,
        idEnvio,
        envio,
        consultaRepasse,
      });

      await pedidoRef.set(
        {
          pagamentoStatus: "repasse_processando",
          repassePrestadorStatus: "processando",
          repassePrestadorMensagem: mensagemProcessando,
          repassePrestadorDadosEfi: envio,
          repassePrestadorConsultaEfi: consultaRepasse,
          dinheiroRetidoAteConfirmacao: true,
          atualizadoEm: agora(),
        },
        { merge: true }
      );

      await db.collection("repasses").doc(idEnvio).set(
        {
          status: "processando",
          dadosEfi: envio,
          consultaEfi: consultaRepasse,
          mensagem: mensagemProcessando,
          atualizadoEm: agora(),
        },
        { merge: true }
      );

      return res.status(202).json({
        sucesso: true,
        status: "processando",
        mensagem: mensagemProcessando,
        valorTotal,
        comissaoApp,
        valorPrestador,
        idEnvio,
      });
    }

    const comprovante = await marcarRepassePixEfiConcluido({
      pedidoRef,
      pedidoId: pedidoIdSeguro,
      prestadorId,
      idEnvio,
      envio,
      consultaRepasse,
      valorPrestador,
      valorTotal,
      comissaoApp,
      chavePixTrabalhador,
    });

    return res.status(200).json({
      sucesso: true,
      mensagem: "Servico confirmado. Repasse enviado com sucesso ao trabalhador.",
      valorTotal,
      comissaoApp,
      valorPrestador,
      idEnvio,
      comprovante,
    });
  } catch (e) {
    console.error("Erro ao confirmar servico e repassar Pix:", e);

    if (String(e.message).includes("REPASSE_JA_CONCLUIDO")) {
      return res.status(200).json({
        sucesso: true,
        mensagem:
          "Repasse ja concluido. O pagamento ao trabalhador foi confirmado.",
        idEnvio,
      });
    }

    if (String(e.message).includes("REPASSE_EM_PROCESSAMENTO")) {
      const resultado = await reconciliarRepassePixEfiPendente(pedidoIdSeguro);

      if (resultado.concluido) {
        return res.status(200).json({
          sucesso: true,
          mensagem:
            "Servico confirmado. Repasse enviado com sucesso ao trabalhador.",
          idEnvio: resultado.idEnvio,
          comprovante: resultado.comprovante,
        });
      }

      return res.status(202).json({
        sucesso: true,
        status: "processando",
        mensagem:
          "Repasse ja esta em processamento e sera confirmado automaticamente.",
        idEnvio: resultado.idEnvio || idEnvio,
      });
    }

    const status = Number(e.status || 500);
    const erroEfi = erroPublicoEfi(e);

    if (pedidoIdSeguro) {
      const erroPersistido = {
        ...erroEfi,
        code: String(e.message || "").includes("PAGAMENTO_NAO_BLOQUEADO")
          ? "PAGAMENTO_NAO_BLOQUEADO"
          : String(e.message || "").includes(
              "SERVICO_NAO_FINALIZADO_PELO_TRABALHADOR"
            )
            ? "SERVICO_NAO_FINALIZADO_PELO_TRABALHADOR"
            : "ERRO_REPASSE_PIX_EFI",
      };

      await db.collection("pedidos").doc(pedidoIdSeguro).set(
        {
          repassePrestadorStatus: "erro",
          repassePrestadorMensagem: erroPersistido.mensagem,
          repassePrestadorErro: erroPersistido,
          pagamentoStatus: "repasse_erro",
          dinheiroRetidoAteConfirmacao: true,
          atualizadoEm: agora(),
        },
        { merge: true }
      );

      if (idEnvio) {
        await db.collection("repasses").doc(idEnvio).set(
          {
            pedidoId: pedidoIdSeguro,
            provedor: "efi",
            idEnvio,
            status: "erro",
            erro: erroPersistido,
            atualizadoEm: agora(),
          },
          { merge: true }
        );
      }
    }

    return res.status(status >= 400 && status < 600 ? status : 500).json({
      erro: "Servico confirmado, mas houve erro ao enviar Pix automatico.",
      detalhes: erroEfi,
      idEnvio,
    });
  }
});

const port = process.env.PORT || 3000;

if (process.env.ENABLE_REPASSE_EFI_WORKER !== "false") {
  const intervaloMs = Math.max(
    Number(process.env.REPASSE_EFI_WORKER_INTERVAL_MS || 60000),
    15000
  );

  setTimeout(() => {
    processarRepassesPixEfiPendentes().catch((e) => {
      console.error("Worker inicial de repasse Pix Efi falhou:", erroPublicoEfi(e));
    });
  }, 5000);

  setInterval(() => {
    processarRepassesPixEfiPendentes().catch((e) => {
      console.error("Worker de repasse Pix Efi falhou:", erroPublicoEfi(e));
    });
  }, intervaloMs);
}

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Backend Render ouvindo na porta ${port}`);
  });
}

module.exports = app;
