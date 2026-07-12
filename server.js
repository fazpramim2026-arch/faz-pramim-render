const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const axios = require("axios");

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
const ASAAS_PIX_KEY = process.env.ASAAS_PIX_KEY;
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

function percentualComissaoApp() {
  const valor = Number(process.env.APP_COMISSAO ?? 0.1);
  if (!Number.isFinite(valor) || valor < 0) return 0.1;
  return valor > 1 ? valor / 100 : valor;
}

function calcularValores(valor) {
  const valorTotalCentavos = Math.round(Number(valor) * 100);
  const comissaoAppCentavos = Math.round(valorTotalCentavos * percentualComissaoApp());
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

async function carregarPixSalvoAsaas(paymentId) {
  const pagamentoIdSeguro = String(paymentId || "").trim();
  if (!pagamentoIdSeguro) return { pixQrCode: "", copiaECola: "" };

  const pagamentoDoc = await db
    .collection("pagamentos")
    .doc(pagamentoIdSeguro)
    .get();
  const pagamento = pagamentoDoc.exists ? pagamentoDoc.data() || {} : {};

  return {
    pixQrCode: pagamento.pixQrCode || pagamento.qrCodeBase64 || "",
    copiaECola: pagamento.copiaECola || pagamento.qrCode || "",
  };
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
  const pixSalvo = await carregarPixSalvoAsaas(pagamentoIdSeguro);
  const pagamentoConfirmado = statusPagamentoAsaasConfirmado(statusAsaas);
  const paidAt = pagamentoConfirmado ? agora() : null;

  await pagamentoRef.set(
    {
      provedor: "asaas",
      gateway: "asaas",
      pagamentoId: pagamentoIdSeguro,
      paymentId: pagamentoIdSeguro,
      asaasPaymentId: pagamentoIdSeguro,
      pedidoId: pedidoId || externalReference || "",
      status: pagamentoConfirmado ? "pago" : statusAsaas,
      valorPago,
      valorTotal,
      comissaoApp,
      valorPrestador,
      pixQrCode: pixSalvo.pixQrCode,
      copiaECola: pixSalvo.copiaECola,
      paidAt,
      asaasPayment: pagamento,
      atualizadoEm: agora(),
    },
    { merge: true }
  );

  if (pedidoRef && pagamentoConfirmado) {
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
        paymentId: pagamentoIdSeguro,
        asaasPaymentId: pagamentoIdSeguro,
        pixQrCode: pixSalvo.pixQrCode,
        copiaECola: pixSalvo.copiaECola,
        paidAt,
        pago: true,
        statusPagamento: "pago",
        pagamentoStatus: "pago_bloqueado",
        status: "pago",
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
    confirmado: pagamentoConfirmado,
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

app.post(["/criarPagamentoPix", "/criarPagamentoPixAsaas"], async (req, res) => {
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
          pixQrCode: pagamentoSalvo.pixQrCode || pagamentoSalvo.qrCodeBase64 || "",
          copiaECola: pagamentoSalvo.copiaECola || pagamentoSalvo.qrCode || "",
          qrCode: pagamentoSalvo.qrCode || pagamentoSalvo.copiaECola || "",
          qrCodeBase64: pagamentoSalvo.qrCodeBase64 || pagamentoSalvo.pixQrCode || "",
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
        paymentId: pagamentoId,
        status: pagamento.status || "PENDING",
        valorTotal,
        comissaoApp,
        valorPrestador,
        valorTrabalhador: valorPrestador,
        qrCode: qr.payload || "",
        qrCodeBase64: qr.encodedImage || "",
        pixQrCode: qr.encodedImage || "",
        copiaECola: qr.payload || "",
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
        paymentId: pagamentoId,
        asaasPaymentId: pagamentoId,
        pixQrCode: qr.encodedImage || "",
        copiaECola: qr.payload || "",
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
      pixQrCode: qr.encodedImage || "",
      copiaECola: qr.payload || "",
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

    const pixSalvo = await carregarPixSalvoAsaas(paymentId);
    const atualizacao = {
      asaasEvent: evento,
      paymentId,
      asaasPaymentId: paymentId,
      pixQrCode: pixSalvo.pixQrCode,
      copiaECola: pixSalvo.copiaECola,
      updatedAt: agora(),
      atualizadoEm: agora(),
    };

    const pagamentoConfirmado = ["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED"].includes(evento);

    if (pagamentoConfirmado) {
      const valorPago = valorNumericoObrigatorio(payment.value || payment.netValue);
      const { valorTotal, comissaoApp, valorPrestador } = calcularValores(valorPago);
      const paidAt = agora();
      Object.assign(atualizacao, {
        gateway: "asaas",
        provedorPagamento: "asaas",
        pago: true,
        statusPagamento: "pago",
        pagamentoStatus: "pago_bloqueado",
        status: "pago",
        paidAt,
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
        pagamentoId: paymentId,
        paymentId,
        asaasPaymentId: paymentId,
        status: pagamentoConfirmado ? "pago" : payment.status || evento,
        pixQrCode: pixSalvo.pixQrCode,
        copiaECola: pixSalvo.copiaECola,
        paidAt: pagamentoConfirmado ? atualizacao.paidAt : null,
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
app.post("/clienteConfirmouServico", async (req, res) => {
  try {
    const decoded = await verificarUsuarioPeloToken(req);
    const { pedidoId, clienteId } = req.body || {};
    const pedidoIdSeguro = normalizarId(pedidoId);

    if (!pedidoIdSeguro || !clienteId) {
      return res.status(400).json({ erro: "Dados obrigatorios faltando" });
    }

    const { pedido } = await carregarPedidoAutorizado(
      pedidoIdSeguro,
      decoded,
      "cliente"
    );

    if (String(clienteId).trim() !== String(pedido.clienteId || "").trim()) {
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
  } catch (e) {
    console.error("Erro ao confirmar servico e solicitar repasse Asaas:", e);
    const status = Number(e.status || 500);
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      erro: e.message || "Servico confirmado, mas houve erro ao solicitar repasse Asaas.",
      detalhes: e.data || erroPublicoAsaas(e),
    });
  }
});
const port = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Backend Render ouvindo na porta ${port}`);
  });
}

module.exports = app;




