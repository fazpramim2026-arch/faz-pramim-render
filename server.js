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

const ASAAS_API_KEY = process.env.ASAAS_API_KEY;
const ASAAS_BASE_URL =
  process.env.ASAAS_BASE_URL || "https://api.asaas.com/v3";

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

function trabalhadorEscolhidoDoPedido(pedido) {
  return String(
    pedido?.trabalhadorId ||
      pedido?.prestadorId ||
      pedido?.profissionalId ||
      pedido?.trabalhadorEscolhidoId ||
      pedido?.prestadorEscolhidoId ||
      pedido?.aceitoPor ||
      ""
  ).trim();
}

function chavePixDoCadastroTrabalhador(trabalhador) {
  const campos = [
    ["chavePix", trabalhador?.chavePix],
    ["pix", trabalhador?.pix],
    ["chave_pix", trabalhador?.chave_pix],
    ["pixKey", trabalhador?.pixKey],
    ["chavePixTrabalhador", trabalhador?.chavePixTrabalhador],
  ];

  for (const [campo, valor] of campos) {
    const chavePix = String(valor || "").trim();
    if (chavePix) {
      return {
        chavePix,
        origemChavePix: `usuarios.${campo}`,
      };
    }
  }

  return {
    chavePix: "",
    origemChavePix: "nao_encontrada_no_cadastro_do_trabalhador",
  };
}

function normalizarChavePixParaEnvio(chavePix) {
  const chaveSemEspacos = String(chavePix || "").trim().replace(/\s+/g, "");
  const apenasDigitos = chaveSemEspacos.replace(/\D/g, "");
  const temApenasPontuacaoDeDocumento =
    /^[\d.\-]+$/.test(chaveSemEspacos) && /[.\-]/.test(chaveSemEspacos);

  if (apenasDigitos.length === 11 && temApenasPontuacaoDeDocumento) {
    return {
      chavePixNormalizada: apenasDigitos,
      formatoChavePixEnviada: "cpf_somente_numeros",
    };
  }

  if (apenasDigitos.length === 11 && /^\d+$/.test(chaveSemEspacos)) {
    return {
      chavePixNormalizada: chaveSemEspacos,
      formatoChavePixEnviada: "cpf_ou_telefone_11_digitos_mantido",
    };
  }

  return {
    chavePixNormalizada: chaveSemEspacos,
    formatoChavePixEnviada: chaveSemEspacos.startsWith("+55")
      ? "telefone_com_codigo_pais_mantido"
      : "chave_mantida_sem_espacos",
  };
}

async function carregarTrabalhadorEscolhidoDoPedido(pedido) {
  const trabalhadorId = trabalhadorEscolhidoDoPedido(pedido);

  if (!trabalhadorId) {
    const erro = new Error("Pedido sem trabalhador vinculado.");
    erro.status = 400;
    throw erro;
  }

  const trabalhadorDoc = await db
    .collection("usuarios")
    .doc(trabalhadorId)
    .get();
  const trabalhador =
    trabalhadorDoc && trabalhadorDoc.exists ? trabalhadorDoc.data() || {} : {};
  const { chavePix, origemChavePix } =
    chavePixDoCadastroTrabalhador(trabalhador);

  return {
    trabalhadorId,
    trabalhador,
    nomeTrabalhador:
      trabalhador.nome || trabalhador.nomeCompleto || trabalhador.apelido || "",
    chavePixTrabalhador: chavePix,
    origemChavePix,
  };
}

function valorDoPedido(pedido) {
  const candidatos = [
    pedido.valorServico,
    pedido.valorOrcamento,
    pedido.valorPago,
    pedido.valorTotal,
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
  const valorTotalCentavos = Math.round(Number(valor) * 100);
  const comissaoAppCentavos = Math.round(valorTotalCentavos * 0.1);
  const valorPrestadorCentavos = valorTotalCentavos - comissaoAppCentavos;
  const valorTotal = Number((valorTotalCentavos / 100).toFixed(2));
  const comissaoApp = Number((comissaoAppCentavos / 100).toFixed(2));
  const valorPrestador = Number((valorPrestadorCentavos / 100).toFixed(2));

  return { valorTotal, comissaoApp, valorPrestador };
}

function numeroPositivo(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) && numero > 0 ? numero : 0;
}

function valorPagoDoPagamento(pagamento) {
  if (!pagamento || typeof pagamento !== "object") return 0;

  return numeroPositivo(
    pagamento.valorPago ||
      pagamento.valorTotal ||
      pagamento.valorServico ||
      pagamento.cobrancaEfiConfirmada?.valor?.original ||
      pagamento.cobrancaEfi?.valor?.original ||
      pagamento.asaasPayment?.value ||
      pagamento.cobrancaAsaas?.value
  );
}

function valorPagoDoPedido(pedido, pagamento = null) {
  return (
    numeroPositivo(pedido.valorPago) ||
    valorPagoDoPagamento(pagamento) ||
    numeroPositivo(pedido.pagamentoValorTotal)
  );
}

function valorOrcamentoDoPedido(pedido) {
  return numeroPositivo(
    pedido.valorOrcamento || pedido.valorServico || pedido.valorTotal
  );
}

function dataHojeIso() {
  return new Date().toISOString().slice(0, 10);
}

function validarAsaasConfig() {
  if (!ASAAS_API_KEY) {
    const erro = new Error("Configuracao Asaas incompleta: ASAAS_API_KEY");
    erro.status = 500;
    throw erro;
  }
}

function erroPublicoAsaas(erro) {
  const detalhes = erro?.response
    ? {
        mensagem: erro.message,
        status: erro.response.status,
        data: erro.response.data,
      }
    : {
        mensagem: erro.message,
        status: erro.status || null,
        data: erro.data || null,
      };

  return {
    mensagem: detalhes.mensagem || "Erro Asaas",
    status: detalhes.status || null,
    data: detalhes.data || null,
  };
}

async function asaasRequest(path, options = {}) {
  validarAsaasConfig();

  const method = String(options.method || "GET").toUpperCase();
  const data = options.data;
  const endpoint = `${ASAAS_BASE_URL}${path}`;

  const resposta = await axios({
    method,
    url: endpoint,
    headers: {
      access_token: ASAAS_API_KEY,
      "Content-Type": "application/json",
      "User-Agent": "FazPraMim/1.0",
    },
    data,
    validateStatus: () => true,
  });

  if (resposta.status < 200 || resposta.status >= 300) {
    console.error("[ASAAS] Request falhou", {
      method,
      path,
      status: resposta.status,
      data: resposta.data,
    });

    const erro = new Error("Erro na API Asaas");
    erro.status = resposta.status;
    erro.data = resposta.data;
    throw erro;
  }

  return resposta.data;
}

function limparDocumento(valor) {
  return String(valor || "").replace(/\D/g, "");
}

function limparTelefone(valor) {
  return String(valor || "").replace(/\D/g, "");
}

function valorNumericoObrigatorio(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero <= 0) {
    const erro = new Error("Valor invalido. Informe um numero maior que zero.");
    erro.status = 400;
    throw erro;
  }
  return Number(numero.toFixed(2));
}

function statusPagamentoAsaasConfirmado(status) {
  return ["RECEIVED", "CONFIRMED"].includes(
    String(status || "").trim().toUpperCase()
  );
}

function statusPagamentoAsaasCancelado(status) {
  return [
    "OVERDUE",
    "DELETED",
    "REFUNDED",
    "REFUND_REQUESTED",
    "CHARGEBACK_REQUESTED",
    "CHARGEBACK_DISPUTE",
  ].includes(String(status || "").trim().toUpperCase());
}

function statusTransferenciaAsaasConcluido(status) {
  return ["DONE", "CONFIRMED", "RECEIVED", "SUCCESS"].includes(
    String(status || "").trim().toUpperCase()
  );
}

function statusTransferenciaAsaasPendente(status) {
  return ["PENDING", "AWAITING_APPROVAL", "BANK_PROCESSING", "SCHEDULED"].includes(
    String(status || "").trim().toUpperCase()
  );
}

function tipoChavePixAsaas(chavePix) {
  const chave = String(chavePix || "").trim();
  const digitos = chave.replace(/\D/g, "");

  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(chave)) return "EMAIL";
  if (chave.startsWith("+")) return "PHONE";
  if (digitos.length === 14) return "CNPJ";
  if (digitos.length === 11) return "CPF";
  if (digitos.length >= 10 && digitos.length <= 13) return "PHONE";
  return "EVP";
}

function chavePixParaAsaas(chavePix) {
  const chave = String(chavePix || "").trim();
  const tipo = tipoChavePixAsaas(chave);

  if (["CPF", "CNPJ"].includes(tipo)) {
    return chave.replace(/\D/g, "");
  }

  if (tipo === "PHONE" && !chave.startsWith("+")) {
    const digitos = chave.replace(/\D/g, "");
    return digitos.startsWith("55") ? `+${digitos}` : `+55${digitos}`;
  }

  return chave;
}

async function buscarOuCriarCustomerAsaas({
  clienteId,
  nomeCliente,
  emailCliente,
  telefoneCliente,
  cpfCnpjCliente,
}) {
  const nome = String(nomeCliente || "").trim();
  const email = String(emailCliente || "").trim();
  const cpfCnpj = limparDocumento(cpfCnpjCliente);
  const telefone = limparTelefone(telefoneCliente);

  if (!nome) {
    const erro = new Error("Informe nomeCliente.");
    erro.status = 400;
    throw erro;
  }

  const consultas = [];
  if (cpfCnpj) consultas.push(`cpfCnpj=${encodeURIComponent(cpfCnpj)}`);
  if (email) consultas.push(`email=${encodeURIComponent(email)}`);

  for (const consulta of consultas) {
    const resultado = await asaasRequest(`/customers?${consulta}`, {
      method: "GET",
    });
    const customer = Array.isArray(resultado?.data) ? resultado.data[0] : null;
    if (customer?.id) return customer;
  }

  console.log("[ASAAS] Criando customer", {
    clienteId,
    nomeCliente: nome,
    emailCliente: email,
    temCpfCnpj: Boolean(cpfCnpj),
    temTelefone: Boolean(telefone),
  });

  return asaasRequest("/customers", {
    method: "POST",
    data: {
      name: nome,
      email: email || undefined,
      phone: telefone || undefined,
      mobilePhone: telefone || undefined,
      cpfCnpj: cpfCnpj || undefined,
      externalReference: String(clienteId || ""),
    },
  });
}

async function localizarPedidoPorPagamentoAsaas(paymentId, externalReference) {
  const pedidoIdDireto = String(externalReference || "").trim();
  if (pedidoIdDireto) {
    const pedidoRef = db.collection("pedidos").doc(pedidoIdDireto);
    const pedidoDoc = await pedidoRef.get();
    if (pedidoDoc.exists) {
      return { pedidoRef, pedido: pedidoDoc.data() || {}, pedidoId: pedidoIdDireto };
    }
  }

  const paymentIdSeguro = String(paymentId || "").trim();
  if (paymentIdSeguro) {
    const snap = await db
      .collection("pedidos")
      .where("asaasPaymentId", "==", paymentIdSeguro)
      .limit(1)
      .get();

    if (!snap.empty) {
      const doc = snap.docs[0];
      return {
        pedidoRef: doc.ref,
        pedido: doc.data() || {},
        pedidoId: doc.id,
      };
    }
  }

  return { pedidoRef: null, pedido: null, pedidoId: "" };
}

async function confirmarPagamentoAsaas(pagamentoId, pedidoIdInformado = "") {
  const pagamentoIdSeguro = String(pagamentoId || "").trim();

  if (!pagamentoIdSeguro) {
    const erro = new Error("Informe pagamentoId.");
    erro.status = 400;
    throw erro;
  }

  const pagamento = await asaasRequest(
    `/payments/${encodeURIComponent(pagamentoIdSeguro)}`,
    { method: "GET" }
  );
  const statusAsaas = String(pagamento.status || "").trim().toUpperCase();
  const externalReference =
    pedidoIdInformado || String(pagamento.externalReference || "").trim();
  const { pedidoRef, pedidoId } = await localizarPedidoPorPagamentoAsaas(
    pagamentoIdSeguro,
    externalReference
  );
  const valorPago = valorNumericoObrigatorio(pagamento.value || pagamento.netValue);
  const { valorTotal, comissaoApp, valorPrestador } = calcularValores(valorPago);
  const pagamentoRef = db.collection("pagamentos").doc(pagamentoIdSeguro);

  await pagamentoRef.set(
    {
      provedor: "asaas",
      gateway: "asaas",
      pagamentoId: pagamentoIdSeguro,
      asaasPaymentId: pagamentoIdSeguro,
      pedidoId: pedidoId || externalReference || "",
      status: statusAsaas,
      valorPago,
      valorTotal,
      comissaoApp,
      valorPrestador,
      asaasPayment: pagamento,
      atualizadoEm: agora(),
    },
    { merge: true }
  );

  if (pedidoRef && statusPagamentoAsaasConfirmado(statusAsaas)) {
    console.log("[ASAAS] Pagamento confirmado", {
      pedidoId,
      pagamentoId: pagamentoIdSeguro,
      status: statusAsaas,
    });

    await pedidoRef.set(
      {
        gateway: "asaas",
        provedorPagamento: "asaas",
        pagamentoId: pagamentoIdSeguro,
        asaasPaymentId: pagamentoIdSeguro,
        pago: true,
        statusPagamento: "pago",
        pagamentoStatus: "pago_bloqueado",
        status: "pago_aguardando_trabalhador",
        valorPago,
        valorTotal,
        comissaoApp,
        valorTrabalhador: valorPrestador,
        valorPrestador,
        chatLiberado: false,
        localizacaoLiberada: false,
        dinheiroRetidoAteConfirmacao: true,
        pagamentoConfirmadoEm: agora(),
        updatedAt: agora(),
        atualizadoEm: agora(),
      },
      { merge: true }
    );
  } else if (pedidoRef && statusPagamentoAsaasCancelado(statusAsaas)) {
    await pedidoRef.set(
      {
        statusPagamento: statusAsaas.toLowerCase(),
        pagamentoStatus: statusAsaas.toLowerCase(),
        asaasPaymentId: pagamentoIdSeguro,
        updatedAt: agora(),
        atualizadoEm: agora(),
      },
      { merge: true }
    );
  }

  return {
    confirmado: statusPagamentoAsaasConfirmado(statusAsaas),
    pagamentoId: pagamentoIdSeguro,
    pedidoId: pedidoId || externalReference || "",
    status: statusAsaas,
    valorTotal,
    comissaoApp,
    valorTrabalhador: valorPrestador,
  };
}

function servicoConfirmadoParaRepasseAsaas(pedido) {
  const statusServico = String(pedido.statusServico || "").trim();
  const status = String(pedido.status || "").trim();

  return (
    statusServico === "confirmado_cliente" ||
    pedido.clienteConfirmouServico === true ||
    pedido.clienteConfirmouFinalizacao === true ||
    status === "concluido"
  );
}

async function solicitarRepasseTrabalhadorAsaas(
  pedidoId,
  { marcarConfirmacaoCliente = false } = {}
) {
  const pedidoIdSeguro = normalizarId(pedidoId);
  const pedidoRef = db.collection("pedidos").doc(pedidoIdSeguro);
  const pedidoDoc = await pedidoRef.get();

  if (!pedidoDoc.exists) {
    const erro = new Error("Pedido nao encontrado.");
    erro.status = 404;
    throw erro;
  }

  const pedido = pedidoDoc.data() || {};
  const statusPagamento = String(
    pedido.statusPagamento || pedido.pagamentoStatus || ""
  ).trim();

  if (!(pedido.pago === true || statusPagamento === "pago")) {
    const erro = new Error("Pedido ainda nao esta pago.");
    erro.status = 400;
    throw erro;
  }

  if (!marcarConfirmacaoCliente && !servicoConfirmadoParaRepasseAsaas(pedido)) {
    const erro = new Error("Servico ainda nao confirmado pelo cliente.");
    erro.status = 400;
    throw erro;
  }

  if (pedido.trabalhadorFinalizou !== true && !servicoConfirmadoParaRepasseAsaas(pedido)) {
    const erro = new Error("Servico ainda nao finalizado pelo trabalhador.");
    erro.status = 400;
    throw erro;
  }

  const repasseStatusAtual = String(
    pedido.repasseStatus || pedido.repassePrestadorStatus || ""
  )
    .trim()
    .toLowerCase();
  if (["concluido", "solicitado", "pendente", "processando"].includes(repasseStatusAtual)) {
    return {
      sucesso: true,
      duplicado: true,
      status: repasseStatusAtual,
      asaasTransferId: pedido.asaasTransferId || "",
      valorRepassado: pedido.valorRepassado || pedido.valorPrestador || 0,
    };
  }

  const {
    trabalhadorId,
    trabalhador,
    chavePixTrabalhador,
    origemChavePix,
  } = await carregarTrabalhadorEscolhidoDoPedido(pedido);

  if (!chavePixTrabalhador) {
    const erro = new Error("Trabalhador sem chave Pix cadastrada.");
    erro.status = 400;
    erro.code = "TRABALHADOR_SEM_PIX";
    throw erro;
  }

  const valorBase = valorPagoDoPedido(pedido) || valorOrcamentoDoPedido(pedido);
  const { valorTotal, comissaoApp, valorPrestador } = calcularValores(valorBase);
  const valorRepassado = valorPrestador;

  if (!Number.isFinite(valorRepassado) || valorRepassado <= 0) {
    const erro = new Error("Valor do repasse invalido.");
    erro.status = 400;
    throw erro;
  }

  console.log("[ASAAS] Iniciando repasse", {
    pedidoId: pedidoIdSeguro,
    trabalhadorId,
    origemChavePix,
    valorTotal,
    comissaoApp,
    valorRepassado,
  });

  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(pedidoRef);
    const dados = snap.data() || {};
    const statusAtual = String(
      dados.repasseStatus || dados.repassePrestadorStatus || ""
    )
      .trim()
      .toLowerCase();

    if (["concluido", "solicitado", "pendente", "processando"].includes(statusAtual)) {
      throw new Error("REPASSE_ASAAS_JA_SOLICITADO");
    }

    if (!marcarConfirmacaoCliente && !servicoConfirmadoParaRepasseAsaas(dados)) {
      throw new Error("SERVICO_NAO_CONFIRMADO_PELO_CLIENTE");
    }

    transaction.set(
      pedidoRef,
      {
        status: "concluido",
        statusServico: "confirmado_cliente",
        clienteConfirmouServico: true,
        clienteConfirmouFinalizacao: true,
        clienteConfirmouEm: agora(),
        repasseGateway: "asaas",
        repasseStatus: "solicitando",
        repassePrestadorStatus: "solicitando",
        pagamentoStatus: "repasse_processando",
        dinheiroRetidoAteConfirmacao: true,
        valorTotal,
        comissaoApp,
        valorTrabalhador: valorPrestador,
        valorPrestador,
        updatedAt: agora(),
        atualizadoEm: agora(),
      },
      { merge: true }
    );
  });

  try {
    const chavePix = chavePixParaAsaas(chavePixTrabalhador);
    const pixAddressKeyType = tipoChavePixAsaas(chavePixTrabalhador);
    const transferencia = await asaasRequest("/transfers", {
      method: "POST",
      data: {
        value: valorRepassado,
        operationType: "PIX",
        pixAddressKey: chavePix,
        pixAddressKeyType,
        description: `Repasse Faz Pra Mim pedido ${pedidoIdSeguro}`.slice(0, 140),
      },
    });
    const asaasTransferId = String(transferencia.id || "").trim();
    const statusTransferencia = String(transferencia.status || "PENDING")
      .trim()
      .toUpperCase();
    const repasseStatus = statusTransferenciaAsaasConcluido(statusTransferencia)
      ? "concluido"
      : statusTransferenciaAsaasPendente(statusTransferencia)
        ? "pendente"
        : "solicitado";

    console.log("[ASAAS] Repasse solicitado", {
      pedidoId: pedidoIdSeguro,
      trabalhadorId,
      asaasTransferId,
      statusTransferencia,
      valorRepassado,
    });

    await pedidoRef.set(
      {
        repasseGateway: "asaas",
        repasseStatus,
        repassePrestadorStatus: repasseStatus,
        asaasTransferId,
        valorRepassado,
        valorTrabalhador: valorPrestador,
        valorPrestador,
        repasseSolicitadoEm: agora(),
        repassePrestadorSolicitadoEm: agora(),
        repasseAsaas: transferencia,
        repasseConcluido: repasseStatus === "concluido",
        dinheiroRetidoAteConfirmacao: repasseStatus !== "concluido",
        pagamentoStatus:
          repasseStatus === "concluido" ? "repasse_concluido" : "repasse_processando",
        updatedAt: agora(),
        atualizadoEm: agora(),
      },
      { merge: true }
    );

    if (asaasTransferId) {
      await db.collection("repasses").doc(asaasTransferId).set(
        {
          pedidoId: pedidoIdSeguro,
          trabalhadorId,
          prestadorId: trabalhadorId,
          trabalhadorNome: trabalhador.nome || trabalhador.nomeCompleto || "",
          provedor: "asaas",
          gateway: "asaas",
          asaasTransferId,
          status: repasseStatus,
          statusAsaas: statusTransferencia,
          chavePixTrabalhador,
          origemChavePix,
          valorTotal,
          comissaoApp,
          valorRepassado,
          transferenciaAsaas: transferencia,
          criadoEm: agora(),
          atualizadoEm: agora(),
        },
        { merge: true }
      );
    }

    return {
      sucesso: true,
      gateway: "asaas",
      repasseStatus,
      asaasTransferId,
      valorRepassado,
      transferencia,
    };
  } catch (e) {
    const erro = erroPublicoAsaas(e);
    console.error("[ASAAS] Erro no repasse", {
      pedidoId: pedidoIdSeguro,
      trabalhadorId,
      erro,
    });

    await pedidoRef.set(
      {
        repasseGateway: "asaas",
        repasseStatus: "erro",
        repassePrestadorStatus: "erro",
        repasseErro: erro,
        repasseErroEm: agora(),
        repassePrestadorErro: erro,
        pagamentoStatus: "repasse_erro",
        dinheiroRetidoAteConfirmacao: true,
        updatedAt: agora(),
        atualizadoEm: agora(),
      },
      { merge: true }
    );

    const erroRetorno = new Error("Erro ao solicitar repasse Asaas.");
    erroRetorno.status = e.status || 500;
    erroRetorno.data = erro;
    throw erroRetorno;
  }
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

function statusRepassePixEfi(envio) {
  return String(envio?.status || envio?.situacao || envio?.estado || "")
    .trim()
    .toUpperCase();
}

function repassePixEfiNaoRealizado(envio) {
  return statusRepassePixEfi(envio) === "NAO_REALIZADO";
}

function detalhesRespostaRepassePixEfi(resposta) {
  return {
    status: statusRepassePixEfi(resposta),
    idEnvio: resposta?.idEnvio || resposta?.idEnvioPix || "",
    idEnvioPix: resposta?.idEnvioPix || "",
    e2eId: resposta?.endToEndId || resposta?.e2eId || "",
    motivo: resposta?.motivo || "",
    erro: resposta?.erro || resposta?.error || "",
    mensagem: resposta?.mensagem || resposta?.message || "",
    detalhes:
      resposta?.detalhes ||
      resposta?.detail ||
      resposta?.violacoes ||
      resposta?.violations ||
      null,
    bodyCompletoEfi: resposta || null,
  };
}

function e2eIdDoRepassePixEfi(...fontes) {
  for (const fonte of fontes) {
    if (!fonte || typeof fonte !== "object") continue;

    const e2eId = String(
      fonte.endToEndId || fonte.e2eId || fonte.end_to_end_id || ""
    ).trim();
    if (e2eId) return e2eId;
  }

  return "";
}

function idEnvioValidoRepassePixEfi(idEnvio) {
  return /^[A-Za-z0-9_-]{1,35}$/.test(String(idEnvio || "").trim());
}

function idEnvioDoRepassePixEfi(...fontes) {
  for (const fonte of fontes) {
    if (!fonte || typeof fonte !== "object") continue;

    const idEnvio = String(
      fonte.idEnvio || fonte.id_envio || fonte.repassePrestadorIdEnvio || ""
    ).trim();
    if (idEnvioValidoRepassePixEfi(idEnvio)) return idEnvio;
  }

  return "";
}

async function consultarRepassePixEfi(idEnvio, ...fontes) {
  const e2eId = e2eIdDoRepassePixEfi(...fontes);
  const idEnvioSeguro = idEnvioValidoRepassePixEfi(idEnvio)
    ? String(idEnvio).trim()
    : idEnvioDoRepassePixEfi(...fontes);
  const consultas = [];

  if (idEnvioSeguro) {
    consultas.push({
      tipoIdentificador: "idEnvio",
      identificador: idEnvioSeguro,
      path: `/v2/gn/pix/enviados/id-envio/${encodeURIComponent(idEnvioSeguro)}`,
    });
  }

  if (e2eId) {
    consultas.push({
      tipoIdentificador: "endToEndId",
      identificador: e2eId,
      path: `/v2/gn/pix/enviados/${encodeURIComponent(e2eId)}`,
    });
  }

  if (!consultas.length) {
    console.warn("Repasse Pix Efi sem identificador consultavel.", {
      idEnvioRecebido: idEnvio || "",
      e2eId,
    });
    return null;
  }

  for (const consulta of consultas) {
    const { tipoIdentificador, identificador, path } = consulta;

    try {
      console.log("Consultando repasse Pix Efi.", {
        tipoIdentificador,
        identificador,
        endpoint: path,
      });
      const resposta = await efiRequest("GET", path);
      console.log("Consulta repasse Pix Efi OK.", {
        tipoIdentificador,
        identificador,
        endpoint: path,
        resposta,
      });
      return resposta;
    } catch (e) {
      console.error("Erro ao consultar repasse Pix Efi:", {
        idEnvio,
        identificador,
        tipoIdentificador,
        endpoint: path,
        erro: erroPublicoEfi(e),
      });
    }
  }

  return null;
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
      repassePrestadorIdEnvio: idEnvio,
      repassePrestadorDadosEfi: envio || null,
      repassePrestadorConsultaEfi: consultaRepasse || null,
      repassePrestadorEndToEndId: e2eIdDoRepassePixEfi(consultaRepasse, envio),
      repassePrestadorComprovante: comprovante,
      repassePrestadorEm: agora(),
      repasseStatus: "REALIZADO",
      repasseConcluido: true,
      repasseValorTrabalhador: valorPrestador,
      repasseAtualizadoEm: agora(),
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
      idEnvioEfi: idEnvioDoRepassePixEfi(consultaRepasse, envio) || idEnvio,
      endToEndId: e2eIdDoRepassePixEfi(consultaRepasse, envio),
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
  const idEnvioLegado = String(pedido.repassePrestadorIdEnvio || "").trim();
  const idEnvio = idEnvioValidoRepassePixEfi(idEnvioLegado)
    ? idEnvioLegado
    : idEnvioDoPedido(pedidoId);

  if (!idEnvio || pedido.repassePrestadorStatus !== "processando") {
    return { concluido: false, idEnvio };
  }

  const repasseSnap = await db.collection("repasses").doc(idEnvio).get();
  const repasse = repasseSnap.exists ? repasseSnap.data() || {} : {};
  const envioSalvo = repasse.dadosEfi || pedido.repassePrestadorDadosEfi || null;
  const consultaSalva = repasse.consultaEfi || pedido.repassePrestadorConsultaEfi || null;
  if (idEnvioLegado && idEnvioLegado !== idEnvio) {
    console.warn("Repasse Pix Efi com idEnvio legado invalido; usando idEnvio calculado.", {
      pedidoId: String(pedidoId),
      idEnvioLegado,
      idEnvioCalculado: idEnvio,
    });
  }
  const idEnvioConsulta = idEnvioDoRepassePixEfi(
    repasse,
    envioSalvo,
    consultaSalva,
    pedido.repassePrestadorComprovante
  ) || idEnvio;
  const consultaRepasse = await consultarRepassePixEfi(
    idEnvioConsulta,
    envioSalvo,
    consultaSalva,
    repasse,
    pedido.repassePrestadorComprovante
  );

  if (!repassePixEfiConfirmado(consultaRepasse)) {
    await db.collection("repasses").doc(idEnvio).set(
      {
        pedidoId: String(pedidoId),
        provedor: "efi",
        idEnvio,
        idEnvioEfi: idEnvioDoRepassePixEfi(consultaRepasse, consultaSalva, envioSalvo, repasse) || idEnvioConsulta,
        endToEndId: e2eIdDoRepassePixEfi(consultaRepasse, consultaSalva, envioSalvo, repasse),
        status: "processando",
        consultaEfi: consultaRepasse || null,
        ultimaConsultaEm: agora(),
        atualizadoEm: agora(),
      },
      { merge: true }
    );

    await pedidoRef.set(
      {
        repassePrestadorIdEnvio: idEnvio,
        atualizadoEm: agora(),
      },
      { merge: true }
    );

    return { concluido: false, idEnvio, consultaRepasse };
  }

  const {
    trabalhadorId: prestadorId,
    nomeTrabalhador,
    chavePixTrabalhador,
    origemChavePix,
  } = await carregarTrabalhadorEscolhidoDoPedido(pedido);
  const valorPago = valorPagoDoPedido(pedido);
  const valorOrcamento = valorOrcamentoDoPedido(pedido);
  const valorBaseRepasse = valorPago || valorOrcamento || valorDoPedido(pedido);
  const {
    valorTotal,
    comissaoApp,
    valorPrestador: valorTrabalhador,
  } = calcularValores(valorBaseRepasse);
  const valorPrestador = valorTrabalhador;

  console.log("Reconciliando repasse Pix Efi; valores recalculados.", {
    pedidoId: String(pedidoId),
    idEnvio,
    trabalhadorId: prestadorId,
    nomeTrabalhador,
    chavePixTrabalhador,
    origemChavePix,
    valorPago,
    valorOrcamento,
    valorTotal,
    valorTrabalhador,
    comissaoApp,
    valorEnviadoParaTrabalhador: valorPrestador,
    valorEnviadoParaEfi: somenteDinheiro(valorPrestador),
    valoresSalvosRepasse: {
      valorTotal: repasse.valorTotal || null,
      valorPrestador: repasse.valorPrestador || null,
      comissaoApp: repasse.comissaoApp || null,
    },
  });

  const comprovante = await marcarRepassePixEfiConcluido({
    pedidoRef,
    pedidoId: String(pedidoId),
    prestadorId,
    idEnvio,
    envio: envioSalvo,
    consultaRepasse,
    valorPrestador,
    valorTotal,
    comissaoApp,
    chavePixTrabalhador,
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
  const statusPagamento = String(pedido.statusPagamento || "").trim();
  if (statusPagamento === "pago") return true;

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
    throw new Error(`ConfiguraÃ§Ã£o EfÃ­ incompleta: ${faltando.join(", ")}`);
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

  console.log("EfÃ­ OAuth: solicitando token client_credentials.");

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
    console.error("EfÃ­ OAuth: falha ao obter token.", {
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
    throw new Error("ConfiguraÃƒÂ§ÃƒÂ£o EfÃƒÂ­ incompleta: EFI_CHAVE_PIX_APP");
  }
}

function urlWebhookPixEfiComIgnorar(url) {
  const webhookUrl = String(url || "").trim();

  if (!webhookUrl) {
    throw new Error("URL do webhook Pix EfÃƒÂ­ nÃƒÂ£o configurada");
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

  console.log("EfÃ­ request:", {
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
    console.error("EfÃ­ request falhou:", {
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

  console.log("EfÃ­ request OK:", {
    method,
    path,
    status: resposta.status,
    data: resposta.data,
  });
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
        console.log("Pix EfÃ­ jÃ¡ existia para o pedido; retornando dados salvos.", {
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

    console.log("Criando cobranÃ§a Pix EfÃ­.", {
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
    console.error("Erro ao criar Pix EfÃ­:", e);
    const status = Number(e.status || 500);
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      erro: "Erro ao criar Pix EfÃ­",
      detalhes: e.message,
    });
  }
});

app.post("/criarPagamentoPixAsaas", async (req, res) => {
  try {
    const decoded = await verificarUsuarioPeloToken(req);
    const {
      pedidoId,
      clienteId,
      trabalhadorId,
      valor,
      nomeCliente,
      emailCliente,
      telefoneCliente,
      cpfCnpjCliente,
    } = req.body || {};
    const pedidoIdSeguro = normalizarId(pedidoId);

    if (!pedidoIdSeguro || !clienteId || !trabalhadorId) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe pedidoId, clienteId e trabalhadorId.",
      });
    }

    const { pedido } = await carregarPedidoAutorizado(
      pedidoIdSeguro,
      decoded,
      "cliente"
    );
    const clienteIdSeguro = String(pedido.clienteId || clienteId).trim();
    const trabalhadorIdSeguro =
      trabalhadorEscolhidoDoPedido(pedido) || String(trabalhadorId || "").trim();
    const valorPedido = valorDoPedido(pedido);
    const valorInformado = valorNumericoObrigatorio(valor || valorPedido);

    if (clienteIdSeguro !== String(clienteId).trim()) {
      return res.status(403).json({ sucesso: false, erro: "Cliente incorreto." });
    }

    if (trabalhadorIdSeguro !== String(trabalhadorId).trim()) {
      return res.status(400).json({
        sucesso: false,
        erro: "Trabalhador informado nao confere com o pedido.",
      });
    }

    if (Math.abs(valorInformado - valorPedido) > 0.01) {
      return res.status(400).json({
        sucesso: false,
        erro: "Valor informado nao confere com o pedido.",
      });
    }

    const { valorTotal, comissaoApp, valorPrestador } =
      calcularValores(valorPedido);

    const pagamentoExistenteSnap = await db
      .collection("pagamentos")
      .where("pedidoId", "==", pedidoIdSeguro)
      .where("provedor", "==", "asaas")
      .limit(1)
      .get();

    if (!pagamentoExistenteSnap.empty) {
      const pagamentoDoc = pagamentoExistenteSnap.docs[0];
      const pagamentoSalvo = pagamentoDoc.data() || {};
      if (pagamentoSalvo.qrCode || pagamentoSalvo.qrCodeBase64) {
        return res.status(200).json({
          sucesso: true,
          gateway: "asaas",
          pagamentoId: pagamentoDoc.id,
          status: pagamentoSalvo.status || "PENDING",
          qrCode: pagamentoSalvo.qrCode || "",
          qrCodeBase64: pagamentoSalvo.qrCodeBase64 || "",
          valorTotal,
          comissaoApp,
          valorTrabalhador: valorPrestador,
        });
      }
    }

    const customer = await buscarOuCriarCustomerAsaas({
      clienteId: clienteIdSeguro,
      nomeCliente,
      emailCliente: decoded.email || emailCliente,
      telefoneCliente,
      cpfCnpjCliente,
    });

    console.log("[ASAAS] Criando cobranca Pix", {
      pedidoId: pedidoIdSeguro,
      clienteId: clienteIdSeguro,
      trabalhadorId: trabalhadorIdSeguro,
      valorTotal,
    });

    const pagamento = await asaasRequest("/payments", {
      method: "POST",
      data: {
        customer: customer.id,
        billingType: "PIX",
        dueDate: dataHojeIso(),
        value: valorTotal,
        description: `Pedido Faz Pra Mim ${pedidoIdSeguro}`,
        externalReference: pedidoIdSeguro,
      },
    });
    const pagamentoId = String(pagamento.id || "").trim();

    if (!pagamentoId) {
      throw new Error("Asaas nao retornou id do pagamento.");
    }

    const qr = await asaasRequest(
      `/payments/${encodeURIComponent(pagamentoId)}/pixQrCode`,
      { method: "GET" }
    );

    console.log("[ASAAS] QR Code Pix gerado", {
      pedidoId: pedidoIdSeguro,
      pagamentoId,
    });

    await db.collection("pagamentos").doc(pagamentoId).set(
      {
        provedor: "asaas",
        gateway: "asaas",
        pedidoId: pedidoIdSeguro,
        clienteId: clienteIdSeguro,
        trabalhadorId: trabalhadorIdSeguro,
        prestadorId: trabalhadorIdSeguro,
        asaasCustomerId: customer.id,
        asaasPaymentId: pagamentoId,
        status: pagamento.status || "PENDING",
        valorTotal,
        comissaoApp,
        valorPrestador,
        valorTrabalhador: valorPrestador,
        qrCode: qr.payload || "",
        qrCodeBase64: qr.encodedImage || "",
        cobrancaAsaas: pagamento,
        pixQrCodeAsaas: qr,
        criadoEm: agora(),
        atualizadoEm: agora(),
      },
      { merge: true }
    );

    await db.collection("pedidos").doc(pedidoIdSeguro).set(
      {
        gateway: "asaas",
        provedorPagamento: "asaas",
        pagamentoId,
        asaasPaymentId: pagamentoId,
        statusPagamento: "aguardando_pagamento",
        pagamentoStatus: "pending",
        status: "aguardando_pagamento",
        pago: false,
        valorTotal,
        comissaoApp,
        valorTrabalhador: valorPrestador,
        valorPrestador,
        trabalhadorId: trabalhadorIdSeguro,
        prestadorId: trabalhadorIdSeguro,
        clienteId: clienteIdSeguro,
        chatLiberado: false,
        localizacaoLiberada: false,
        dinheiroRetidoAteConfirmacao: true,
        updatedAt: agora(),
        atualizadoEm: agora(),
      },
      { merge: true }
    );

    return res.status(200).json({
      sucesso: true,
      gateway: "asaas",
      pagamentoId,
      status: pagamento.status || "PENDING",
      qrCode: qr.payload || "",
      qrCodeBase64: qr.encodedImage || "",
      valorTotal,
      comissaoApp,
      valorTrabalhador: valorPrestador,
    });
  } catch (e) {
    console.error("[ASAAS] Erro ao criar pagamento Pix", erroPublicoAsaas(e));
    const status = Number(e.status || 500);
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      sucesso: false,
      erro: "Erro ao criar pagamento Pix Asaas",
      detalhes: erroPublicoAsaas(e),
    });
  }
});

app.post("/webhookAsaas", async (req, res) => {
  try {
    console.log("[ASAAS] Webhook recebido", {
      event: req.body?.event || "",
      paymentId: req.body?.payment?.id || "",
    });

    const evento = String(req.body?.event || "").trim().toUpperCase();
    const payment = req.body?.payment || {};
    const paymentId = String(payment.id || "").trim();
    const externalReference = String(payment.externalReference || "").trim();

    if (!evento || !paymentId) {
      return res.status(200).send("Webhook Asaas ignorado");
    }

    const { pedidoRef, pedidoId } = await localizarPedidoPorPagamentoAsaas(
      paymentId,
      externalReference
    );

    if (!pedidoRef) {
      console.warn("[ASAAS] Webhook sem pedido encontrado", {
        evento,
        paymentId,
        externalReference,
      });
      return res.status(200).send("Webhook Asaas sem pedido");
    }

    const atualizacao = {
      asaasEvent: evento,
      asaasPaymentId: paymentId,
      updatedAt: agora(),
      atualizadoEm: agora(),
    };

    if (["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED"].includes(evento)) {
      const valorPago = valorNumericoObrigatorio(payment.value || payment.netValue);
      const { valorTotal, comissaoApp, valorPrestador } = calcularValores(valorPago);
      Object.assign(atualizacao, {
        gateway: "asaas",
        provedorPagamento: "asaas",
        pago: true,
        statusPagamento: "pago",
        pagamentoStatus: "pago_bloqueado",
        status: "pago_aguardando_trabalhador",
        valorPago,
        valorTotal,
        comissaoApp,
        valorTrabalhador: valorPrestador,
        valorPrestador,
        chatLiberado: false,
        localizacaoLiberada: false,
        dinheiroRetidoAteConfirmacao: true,
        pagamentoConfirmadoEm: agora(),
      });

      console.log("[ASAAS] Pagamento confirmado", {
        pedidoId,
        paymentId,
        evento,
      });
    } else if (
      [
        "PAYMENT_OVERDUE",
        "PAYMENT_DELETED",
        "PAYMENT_REFUNDED",
        "PAYMENT_REFUND_REQUESTED",
      ].includes(evento)
    ) {
      Object.assign(atualizacao, {
        statusPagamento: evento.toLowerCase(),
        pagamentoStatus: evento.toLowerCase(),
      });
    }

    await pedidoRef.set(atualizacao, { merge: true });
    await db.collection("pagamentos").doc(paymentId).set(
      {
        provedor: "asaas",
        gateway: "asaas",
        pedidoId,
        asaasPaymentId: paymentId,
        status: payment.status || evento,
        asaasEvent: evento,
        asaasPayment: payment,
        atualizadoEm: agora(),
      },
      { merge: true }
    );

    return res.status(200).send("Webhook Asaas processado");
  } catch (e) {
    console.error("[ASAAS] Erro webhook", erroPublicoAsaas(e));
    return res.status(200).send("Erro interno webhook Asaas");
  }
});

app.post("/verificarPagamentoAsaas", async (req, res) => {
  try {
    const { pedidoId, pagamentoId } = req.body || {};
    const resultado = await confirmarPagamentoAsaas(pagamentoId, pedidoId);

    return res.status(200).json({
      sucesso: true,
      gateway: "asaas",
      ...resultado,
    });
  } catch (e) {
    const status = Number(e.status || 500);
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      sucesso: false,
      erro: "Erro ao verificar pagamento Asaas",
      detalhes: erroPublicoAsaas(e),
    });
  }
});

app.post("/repassarTrabalhadorAsaas", async (req, res) => {
  try {
    const { pedidoId } = req.body || {};
    const pedidoIdSeguro = normalizarId(pedidoId);

    if (!pedidoIdSeguro) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe pedidoId.",
      });
    }

    const resultado = await solicitarRepasseTrabalhadorAsaas(pedidoIdSeguro);
    return res.status(resultado.duplicado ? 202 : 200).json(resultado);
  } catch (e) {
    const status = Number(e.status || 500);
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      sucesso: false,
      erro: e.message || "Erro ao repassar trabalhador Asaas",
      detalhes: e.data || erroPublicoAsaas(e),
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
    console.error("Erro ao cadastrar webhook Pix EfÃƒÂ­:", e);
    return res.status(500).json({
      sucesso: false,
      erro: "Erro ao cadastrar webhook Pix EfÃƒÂ­",
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
      erro: "Pagamento EfÃ­ sem pedidoId",
    };
  }

  const valorPago = numeroPositivo(cobrancaAtual.valor?.original) ||
    valorPagoDoPagamento(pagamento);
  const { valorTotal, comissaoApp, valorPrestador } = calcularValores(valorPago);

  console.log("Pagamento Pix Efi confirmado; valores gravados no pedido.", {
    pedidoId,
    txid: txidSeguro,
    valorPago,
    valorTotal,
    comissaoApp,
    valorPrestador,
    cobrancaEfi: cobrancaAtual,
  });

  await pagamentoRef.set({
    ...pagamento,
    provedor: "efi",
    txid: txidSeguro,
    pedidoId,
    status: "CONCLUIDA",
    pagamentoStatus: "pago_bloqueado",
    pago: true,
    valorPago,
    valorTotal,
    comissaoApp,
    valorPrestador,
    cobrancaEfiConfirmada: cobrancaAtual,
    atualizadoEm: agora(),
  }, { merge: true });

  await db.collection("pedidos").doc(String(pedidoId)).set({
    pago: true,
    pagamentoStatus: "pago_bloqueado",
    status: "pago_aguardando_trabalhador",
    valorPago,
    valorTotal,
    comissaoApp,
    valorPrestador,
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
    console.error("Erro ao verificar pagamento EfÃ­:", e);
    return res.status(500).json({
      sucesso: false,
      erro: "Erro ao verificar pagamento EfÃ­",
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

    const gatewayPedido = String(
      pedido.gateway || pedido.provedorPagamento || pedido.provedor || ""
    )
      .trim()
      .toLowerCase();

    if (gatewayPedido === "asaas" || pedido.asaasPaymentId) {
      const resultadoAsaas = await solicitarRepasseTrabalhadorAsaas(
        pedidoIdSeguro,
        { marcarConfirmacaoCliente: true }
      );

      return res.status(resultadoAsaas.duplicado ? 202 : 200).json({
        sucesso: true,
        mensagem: resultadoAsaas.duplicado
          ? "Repasse Asaas ja solicitado e aguardando confirmacao."
          : "Servico confirmado. Repasse Asaas solicitado.",
        ...resultadoAsaas,
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

    const {
      trabalhadorId: prestadorId,
      nomeTrabalhador,
      chavePixTrabalhador,
      origemChavePix,
    } = await carregarTrabalhadorEscolhidoDoPedido(pedido);

    if (!chavePixTrabalhador) {
      console.error("Trabalhador escolhido sem chave Pix cadastrada.", {
        pedidoId: pedidoIdSeguro,
        trabalhadorId: prestadorId,
      });
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

    const pagamentoIdSeguro = String(
      pedido.txidEfi || pedido.pagamentoId || txidDoPedido(pedidoIdSeguro)
    ).trim();
    const pagamentoSnap = pagamentoIdSeguro
      ? await db.collection("pagamentos").doc(pagamentoIdSeguro).get()
      : null;
    const pagamento = pagamentoSnap?.exists ? pagamentoSnap.data() || {} : null;
    const valorPago = valorPagoDoPedido(pedido, pagamento);
    const valorServico = valorPago;
    const valorOrcamento = valorOrcamentoDoPedido(pedido);
    const valorBaseRepasse = valorServico;
    const {
      valorTotal,
      comissaoApp,
      valorPrestador: valorTrabalhador,
    } = calcularValores(valorBaseRepasse);
    const valorPrestador = valorTrabalhador;

    if (!Number.isFinite(valorPrestador) || valorPrestador <= 0) {
      return res.status(400).json({ erro: "Valor do repasse invalido." });
    }

    const cfg = validarEfiConfig();
    exigirChavePixEfi(cfg);
    idEnvio = idEnvioDoPedido(pedidoIdSeguro);
    const { chavePixNormalizada, formatoChavePixEnviada } =
      normalizarChavePixParaEnvio(chavePixTrabalhador);

    console.log("Cliente confirmou servico; preparando repasse Pix EfÃ­.", {
      pedidoId: pedidoIdSeguro,
      clienteId: clienteIdSeguro,
      prestadorId,
      idEnvio,
      pagamentoId: pagamentoIdSeguro,
      trabalhadorIdEscolhido: prestadorId,
      nomeTrabalhador,
      chavePixTrabalhador,
      origemChavePix,
      chavePixNormalizadaEnviada: chavePixNormalizada,
      formatoChavePixEnviada,
      valorPago,
      valorServico,
      valorOrcamento,
      valorTotal,
      valorTrabalhador,
      comissaoApp,
      valorPrestador,
      valorEnviadoParaTrabalhador: valorPrestador,
      valorEnviadoParaEfi: somenteDinheiro(valorPrestador),
      valoresSalvosNoPedido: {
        valorTotal: pedido.valorTotal || null,
        valorServico: pedido.valorServico || null,
        valorPrestador: pedido.valorPrestador || null,
        comissaoApp: pedido.comissaoApp || null,
      },
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

      const trabalhadorIdAtual = trabalhadorEscolhidoDoPedido(dados);
      if (trabalhadorIdAtual !== prestadorId) {
        throw new Error("TRABALHADOR_ESCOLHIDO_ALTERADO_NO_PEDIDO");
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
          valorPago,
          valorOrcamento,
          valorTotal,
          comissaoApp,
          valorPrestador,
          valorTrabalhador,
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
        chavePixNormalizadaEnviada: chavePixNormalizada,
        origemChavePix,
        pagamentoId: pagamentoIdSeguro,
        valorPago,
        valorServico,
        valorOrcamento,
        valorTotal,
        comissaoApp,
        valorPrestador,
        valorTrabalhador,
        valorEnviadoParaTrabalhador: valorPrestador,
        provedor: "efi",
        idEnvio,
        idEnvioEfi: idEnvio,
        status: "processando",
        criadoEm: agora(),
        atualizadoEm: agora(),
      },
      { merge: true }
    );

    const valorEnviadoParaEfi = somenteDinheiro(valorPrestador);

    console.log("Enviando repasse Pix Efi.", {
      pedidoId: pedidoIdSeguro,
      trabalhadorIdEscolhido: prestadorId,
      nomeTrabalhador,
      chavePixTrabalhador,
      origemChavePix,
      chavePixNormalizadaEnviada: chavePixNormalizada,
      formatoChavePixEnviada,
      valorPago,
      valorServico,
      valorOrcamento,
      valorTotal,
      valorTrabalhador,
      comissaoApp,
      valorEnviadoParaTrabalhador: valorPrestador,
      valorEnviadoParaEfi,
      endpoint: `/v3/gn/pix/${idEnvio}`,
    });

    const envio = await efiRequest("PUT", `/v3/gn/pix/${idEnvio}`, {
      valor: valorEnviadoParaEfi,
      pagador: {
        chave: cfg.chavePixApp,
        infoPagador: `Repasse Faz Pra Mim pedido ${pedidoIdSeguro}`.slice(
          0,
          140
        ),
      },
      favorecido: { chave: chavePixNormalizada },
    });

    const detalhesEnvio = detalhesRespostaRepassePixEfi(envio);
    console.log("Resposta completa do repasse Pix Efi recebida.", {
      pedidoId: pedidoIdSeguro,
      idEnvio,
      ...detalhesEnvio,
    });

    const consultaRepasse = await consultarRepassePixEfi(idEnvio, envio);
    const confirmacaoRepasse = consultaRepasse || envio;
    const endToEndIdRepasse = e2eIdDoRepassePixEfi(consultaRepasse, envio);
    const idEnvioEfi = idEnvioDoRepassePixEfi(consultaRepasse, envio) || idEnvio;

    const detalhesConfirmacao = detalhesRespostaRepassePixEfi(confirmacaoRepasse);
    console.log("Consulta completa do repasse Pix Efi recebida.", {
      pedidoId: pedidoIdSeguro,
      idEnvio,
      idEnvioEfi,
      endToEndId: endToEndIdRepasse,
      valor: confirmacaoRepasse.valor || "",
      ...detalhesConfirmacao,
    });

    if (repassePixEfiNaoRealizado(confirmacaoRepasse)) {
      const erroDetalhado = detalhesRespostaRepassePixEfi(confirmacaoRepasse);

      console.error("Repasse Pix Efi retornou NAO_REALIZADO.", {
        pedidoId: pedidoIdSeguro,
        trabalhadorId: prestadorId,
        nomeTrabalhador,
        chavePixTrabalhador,
        origemChavePix,
        chavePixNormalizadaEnviada: chavePixNormalizada,
        formatoChavePixEnviada,
        valorTotalPago: valorTotal,
        valorServico,
        comissaoApp,
        valorEnviadoAoTrabalhador: valorPrestador,
        respostaCompleta: erroDetalhado,
      });

      await pedidoRef.set(
        {
          pagamentoStatus: "repasse_erro",
          repassePrestadorStatus: "nao_realizado",
          repassePrestadorMensagem:
            "Repasse Pix nao realizado pela Efi. Pedido disponivel para nova tentativa/manual.",
          repassePrestadorDadosEfi: envio,
          repassePrestadorConsultaEfi: consultaRepasse,
          repasseStatus: "NAO_REALIZADO",
          repasseConcluido: false,
          repasseErroDetalhado: erroDetalhado,
          repasseAtualizadoEm: agora(),
          dinheiroRetidoAteConfirmacao: true,
          atualizadoEm: agora(),
        },
        { merge: true }
      );

      await db.collection("repasses").doc(idEnvio).set(
        {
          status: "NAO_REALIZADO",
          erroDetalhado,
          dadosEfi: envio,
          consultaEfi: consultaRepasse,
          atualizadoEm: agora(),
        },
        { merge: true }
      );

      return res.status(422).json({
        sucesso: false,
        status: "NAO_REALIZADO",
        erro:
          "Repasse Pix nao realizado pela Efi. Verifique os detalhes para nova tentativa/manual.",
        detalhes: erroDetalhado,
        idEnvio,
      });
    }

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
          repassePrestadorEndToEndId: endToEndIdRepasse,
          dinheiroRetidoAteConfirmacao: true,
          atualizadoEm: agora(),
        },
        { merge: true }
      );

      await db.collection("repasses").doc(idEnvio).set(
        {
          status: "processando",
          idEnvioEfi,
          endToEndId: endToEndIdRepasse,
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

