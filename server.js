const express = require('express');
const cors = require('cors');
const https = require('https');
const axios = require('axios');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;
const EFI_BASE_URL = process.env.EFI_BASE_URL || 'https://pix.api.efipay.com.br';
const EFI_CLIENT_ID = process.env.EFI_CLIENT_ID;
const EFI_CLIENT_SECRET = process.env.EFI_CLIENT_SECRET;
const EFI_CHAVE_PIX_APP = process.env.EFI_CHAVE_PIX_APP;
const EFI_CERT_BASE64 = process.env.EFI_CERT_BASE64;
const EFI_CERT_PASSWORD = process.env.EFI_CERT_PASSWORD || '';
const APP_COMISSAO = Number(process.env.APP_COMISSAO || '0.10');
const FIREBASE_SERVICE_ACCOUNT_BASE64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

function required(name, value) {
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
}

function dinheiro2(valor) {
  return Number(Number(valor || 0).toFixed(2));
}

function calcularValores(valor) {
  const valorTotal = dinheiro2(valor);
  const comissaoApp = dinheiro2(valorTotal * APP_COMISSAO);
  const valorTrabalhador = dinheiro2(valorTotal - comissaoApp);
  return { valorTotal, comissaoApp, valorTrabalhador };
}

function agora() {
  return admin.firestore.FieldValue.serverTimestamp();
}

function initFirebase() {
  if (admin.apps.length) return;
  required('FIREBASE_SERVICE_ACCOUNT_BASE64', FIREBASE_SERVICE_ACCOUNT_BASE64);
  const json = Buffer.from(FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
  const serviceAccount = JSON.parse(json);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

function efiHttpsAgent() {
  required('EFI_CERT_BASE64', EFI_CERT_BASE64);
  const pfx = Buffer.from(EFI_CERT_BASE64, 'base64');
  return new https.Agent({
    pfx,
    passphrase: EFI_CERT_PASSWORD,
    rejectUnauthorized: true,
  });
}

function efiClient() {
  return axios.create({
    baseURL: EFI_BASE_URL,
    httpsAgent: efiHttpsAgent(),
    timeout: 30000,
    headers: { 'Content-Type': 'application/json' },
  });
}

let tokenCache = { token: null, expiresAt: 0 };
async function getEfiToken() {
  required('EFI_CLIENT_ID', EFI_CLIENT_ID);
  required('EFI_CLIENT_SECRET', EFI_CLIENT_SECRET);

  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) {
    return tokenCache.token;
  }

  const basic = Buffer.from(`${EFI_CLIENT_ID}:${EFI_CLIENT_SECRET}`).toString('base64');
  const client = efiClient();
  const resp = await client.post('/oauth/token', { grant_type: 'client_credentials' }, {
    headers: { Authorization: `Basic ${basic}` },
  });

  tokenCache = {
    token: resp.data.access_token,
    expiresAt: Date.now() + Number(resp.data.expires_in || 3600) * 1000,
  };
  return tokenCache.token;
}

async function efiRequest(method, path, body, extraHeaders = {}) {
  const token = await getEfiToken();
  const client = efiClient();
  try {
    const resp = await client.request({
      method,
      url: path,
      data: body,
      headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
    });
    return resp.data;
  } catch (e) {
    console.log('Erro completo retornado pela Efi:', {
      method,
      path,
      status: e?.response?.status,
      headers: e?.response?.headers,
      data: e?.response?.data,
      message: e.message,
    });
    throw e;
  }
}

function webhookPixEfiUrlComIgnorar(webhookUrl) {
  const url = String(webhookUrl || '').trim();
  if (!url) throw new Error('URL do webhook Pix Efi ausente');
  if (/[?&]ignorar=/.test(url)) return url;
  return url.includes('?') ? `${url}&ignorar=` : `${url}?ignorar=`;
}

async function criarNotificacao(db, userId, titulo, mensagem, tipo, pedidoId) {
  if (!userId) return;
  await db.collection('notificacoes').add({
    userId, titulo, mensagem, tipo, pedidoId: pedidoId || '', lida: false, criadoEm: agora(),
  });
}

app.get('/', (req, res) => res.json({ ok: true, app: 'Faz Pra Mim Efí Render Backend' }));
app.get('/health', (req, res) => res.json({ ok: true, at: new Date().toISOString() }));

app.post('/configurarWebhookPixEfi', async (req, res) => {
  try {
    required('EFI_CHAVE_PIX_APP', EFI_CHAVE_PIX_APP);
    const webhookUrl = 'https://faz-pramim-render.onrender.com/webhookPixEfi';
    const resposta = await efiRequest(
      'PUT',
      `/v2/webhook/${encodeURIComponent(EFI_CHAVE_PIX_APP)}`,
      { webhookUrl }
    );

    res.json({
      sucesso: true,
      chave: EFI_CHAVE_PIX_APP,
      webhookUrl,
      resposta,
    });
  } catch (e) {
    console.error('configurarWebhookPixEfi erro', e?.response?.data || e.message);
    res.status(500).json({
      erro: 'Erro ao configurar webhook Pix Efí',
      detalhes: e?.response?.data || e.message,
    });
  }
});

app.post('/cadastrarWebhookPixEfi', async (req, res) => {
  try {
    required('EFI_CHAVE_PIX_APP', EFI_CHAVE_PIX_APP);
    const webhookUrl = webhookPixEfiUrlComIgnorar(
      req.body?.webhookUrl || 'https://faz-pramim-render.onrender.com/webhookPixEfi'
    );
    const resposta = await efiRequest(
      'PUT',
      `/v2/webhook/${encodeURIComponent(EFI_CHAVE_PIX_APP)}`,
      { webhookUrl },
      { 'x-skip-mtls-checking': 'true' }
    );

    res.json({
      sucesso: true,
      chave: EFI_CHAVE_PIX_APP,
      webhookUrl,
      resposta,
    });
  } catch (e) {
    console.error('cadastrarWebhookPixEfi erro', e?.response?.data || e.message);
    res.status(500).json({
      erro: 'Erro ao cadastrar webhook Pix Efi',
      detalhes: e?.response?.data || e.message,
    });
  }
});

app.post('/criarPagamentoPix', async (req, res) => {
  try {
    initFirebase();
    required('EFI_CHAVE_PIX_APP', EFI_CHAVE_PIX_APP);
    const db = admin.firestore();

    const { pedidoId, clienteId, prestadorId, valor, descricao, emailCliente } = req.body || {};
    if (!pedidoId || !clienteId || !prestadorId || !valor) {
      return res.status(400).json({ erro: 'Dados obrigatórios faltando: pedidoId, clienteId, prestadorId, valor' });
    }

    const { valorTotal, comissaoApp, valorTrabalhador } = calcularValores(valor);
    const baseTxid = String(pedidoId || '').replace(/[^a-zA-Z0-9]/g, '');
    const txid = baseTxid.length >= 26 && baseTxid.length <= 35
    ? baseTxid
    : uuidv4().replace(/-/g, '').slice(0, 32);

    const cob = await efiRequest('PUT', `/v2/cob/${txid}`, {
      calendario: { expiracao: 300 },
      valor: { original: valorTotal.toFixed(2) },
      chave: EFI_CHAVE_PIX_APP,
      solicitacaoPagador: descricao || 'Pagamento Faz Pra Mim',
      infoAdicionais: [
        { nome: 'pedidoId', valor: String(pedidoId) },
        { nome: 'clienteId', valor: String(clienteId) },
        { nome: 'prestadorId', valor: String(prestadorId) },
      ],
    });

    const locId = cob?.loc?.id;
    let qr = {};
    if (locId) {
      qr = await efiRequest('GET', `/v2/loc/${locId}/qrcode`);
    }

    await db.collection('pagamentos').doc(txid).set({
      gateway: 'efi', txid, pedidoId, clienteId, prestadorId,
      valorTotal, comissaoApp, valorTrabalhador,
      status: cob.status || 'ATIVA',
      qrCode: qr.qrcode || '',
      qrCodeBase64: qr.imagemQrcode || '',
      copiaECola: qr.qrcode || '',
      locId: locId || null,
      criadoEm: agora(), atualizadoEm: agora(),
      expiraEm: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 5 * 60 * 1000)),
    }, { merge: true });

    await db.collection('pedidos').doc(String(pedidoId)).set({
      gatewayPagamento: 'efi', pagamentoId: txid, txid,
      pagamentoStatus: 'pending', pago: false,
      status: 'aguardando_pagamento', clienteId, prestadorId,
      valorTotal, comissaoApp, valorTrabalhador,
      chatLiberado: false, localizacaoLiberada: false,
      dinheiroRetidoAteConfirmacao: true,
      pagamentoExpiraEm: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 5 * 60 * 1000)),
      atualizadoEm: agora(),
    }, { merge: true });

    res.json({
      sucesso: true,
      gateway: 'efi', pagamentoId: txid, txid,
      status: 'pending', valorTotal, comissaoApp, valorTrabalhador,
      qrCode: qr.qrcode || '', qrCodeBase64: qr.imagemQrcode || '', ticketUrl: qr.linkVisualizacao || '',
    });
  } catch (e) {
    console.error('criarPagamentoPix erro', e?.response?.data || e.message);
    res.status(500).json({ erro: 'Erro ao criar Pix Efí', detalhes: e?.response?.data || e.message });
  }
});

app.post('/webhookPixEfi', async (req, res) => {
  try {
    initFirebase();
    const db = admin.firestore();
    const pixList = Array.isArray(req.body?.pix) ? req.body.pix : [];

    for (const pix of pixList) {
      const txid = pix.txid;
      if (!txid) continue;

      const pagamentoRef = db.collection('pagamentos').doc(String(txid));
      const pagamentoDoc = await pagamentoRef.get();
      const pagamento = pagamentoDoc.data() || {};
      const pedidoId = pagamento.pedidoId;
      if (!pedidoId) continue;

      await pagamentoRef.set({
        status: 'CONCLUIDA', pagamentoStatus: 'pago_bloqueado', e2eId: pix.endToEndId || '',
        valorPago: Number(pix.valor || pagamento.valorTotal || 0),
        pagoEm: agora(), atualizadoEm: agora(), webhookPayload: pix,
      }, { merge: true });

      await db.collection('pedidos').doc(String(pedidoId)).set({
        pago: true,
        pagamentoStatus: 'pago_bloqueado',
        status: 'pago_aguardando_trabalhador',
        chatLiberado: false,
        localizacaoLiberada: false,
        trabalhadorClicouEstouIndo: false,
        pagamentoConfirmadoEm: agora(),
        atualizadoEm: agora(),
      }, { merge: true });
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('webhookPixEfi erro', e);
    res.status(200).json({ ok: false });
  }
});

app.post('/verificarPagamentoManual', async (req, res) => {
  try {
    initFirebase();
    const db = admin.firestore();
    const { pagamentoId, txid, pedidoId } = req.body || {};
    const txidSeguro = String(txid || pagamentoId || '').trim();
    const pedidoIdInformado = String(pedidoId || '').trim();

    if (!txidSeguro) {
      return res.status(400).json({ erro: 'Informe pagamentoId ou txid' });
    }

    const cob = await efiRequest('GET', `/v2/cob/${txidSeguro}`);
    const statusEfi = String(cob.status || '');
    const pagamentoRef = db.collection('pagamentos').doc(txidSeguro);
    const pagamentoDoc = await pagamentoRef.get();
    const pagamento = pagamentoDoc.data() || {};
    let pedidoIdSeguro = String(pagamento.pedidoId || pedidoIdInformado || '').trim();

    if (!pedidoIdSeguro) {
      const pedidoSnap = await db
        .collection('pedidos')
        .where('txid', '==', txidSeguro)
        .limit(1)
        .get();

      if (!pedidoSnap.empty) {
        pedidoIdSeguro = pedidoSnap.docs[0].id;
      }
    }

    if (statusEfi !== 'CONCLUIDA') {
      await pagamentoRef.set({
        gateway: 'efi',
        txid: txidSeguro,
        pedidoId: pedidoIdSeguro || pagamento.pedidoId || '',
        status: statusEfi,
        cobrancaEfi: cob,
        atualizadoEm: agora(),
      }, { merge: true });

      return res.json({
        sucesso: true,
        confirmado: false,
        pagamentoId: txidSeguro,
        txid: txidSeguro,
        pedidoId: pedidoIdSeguro,
        status: statusEfi,
      });
    }

    if (!pedidoIdSeguro) {
      return res.status(400).json({
        erro: 'Pagamento Efí confirmado, mas pedidoId não foi encontrado',
        pagamentoId: txidSeguro,
        txid: txidSeguro,
        status: statusEfi,
      });
    }

    await pagamentoRef.set({
      gateway: 'efi',
      txid: txidSeguro,
      pedidoId: pedidoIdSeguro,
      status: 'CONCLUIDA',
      pagamentoStatus: 'pago_bloqueado',
      pago: true,
      cobrancaEfi: cob,
      atualizadoEm: agora(),
    }, { merge: true });

    await db.collection('pedidos').doc(String(pedidoIdSeguro)).set({
      pago: true,
      pagamentoStatus: 'pago_bloqueado',
      status: 'pago_aguardando_trabalhador',
      chatLiberado: false,
      localizacaoLiberada: false,
      dinheiroRetidoAteConfirmacao: true,
      pagamentoConfirmadoEm: agora(),
      atualizadoEm: agora(),
    }, { merge: true });

    return res.json({
      sucesso: true,
      confirmado: true,
      pagamentoId: txidSeguro,
      txid: txidSeguro,
      pedidoId: pedidoIdSeguro,
      status: 'CONCLUIDA',
      pagamentoStatus: 'pago_bloqueado',
    });
  } catch (e) {
    console.error('verificarPagamentoManual erro', e?.response?.data || e.message);
    return res.status(500).json({
      erro: 'Erro ao verificar pagamento Efí',
      detalhes: e?.response?.data || e.message,
    });
  }
});

app.post('/trabalhadorEstouIndo', async (req, res) => {
  try {
    initFirebase();
    const db = admin.firestore();
    const { pedidoId, prestadorId } = req.body || {};
    if (!pedidoId || !prestadorId) return res.status(400).json({ erro: 'Informe pedidoId e prestadorId' });

    const ref = db.collection('pedidos').doc(String(pedidoId));
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ erro: 'Pedido não encontrado' });
    const pedido = doc.data();
    if (pedido.prestadorId !== prestadorId) return res.status(403).json({ erro: 'Trabalhador incorreto' });
    if (pedido.pago !== true) return res.status(400).json({ erro: 'Pedido ainda não foi pago' });

    await ref.set({
      status: 'trabalhador_a_caminho', trabalhadorClicouEstouIndo: true,
      chatLiberado: true, localizacaoLiberada: true,
      trabalhadorEstouIndoEm: agora(), atualizadoEm: agora(),
    }, { merge: true });

    res.json({ sucesso: true });
  } catch (e) {
    res.status(500).json({ erro: 'Erro ao marcar Estou indo', detalhes: e.message });
  }
});

app.post('/prestadorFinalizouServico', async (req, res) => {
  try {
    initFirebase();
    const db = admin.firestore();
    const { pedidoId, prestadorId } = req.body || {};
    if (!pedidoId || !prestadorId) return res.status(400).json({ erro: 'Informe pedidoId e prestadorId' });

    const ref = db.collection('pedidos').doc(String(pedidoId));
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ erro: 'Pedido não encontrado' });
    const pedido = doc.data();
    if (pedido.prestadorId !== prestadorId) return res.status(403).json({ erro: 'Trabalhador incorreto' });
    if (pedido.pago !== true) return res.status(400).json({ erro: 'Pedido ainda não foi pago' });

    await ref.set({
      status: 'aguardando_confirmacao_cliente',
      trabalhadorFinalizou: true,
      servicoFinalizadoPeloPrestador: true,
      servicoFinalizadoEm: agora(), atualizadoEm: agora(),
    }, { merge: true });

    res.json({ sucesso: true, mensagem: 'Serviço finalizado. Aguardando confirmação do cliente.' });
  } catch (e) {
    res.status(500).json({ erro: 'Erro ao finalizar serviço', detalhes: e.message });
  }
});

async function enviarPixParaTrabalhador({ chavePix, valor, descricao }) {
  const idEnvio = uuidv4().replace(/-/g, '').slice(0, 32);
  const body = {
    valor: valor.toFixed(2),
    pagador: { chave: EFI_CHAVE_PIX_APP },
    favorecido: { chave: chavePix },
  };
  console.log('Body enviado para envio Pix Efi:', body);
  console.log("Enviando repasse Pix", body);
  try {
    const token = await getEfiToken();
    const client = efiClient();
    const response = await client.request({
      method: 'PUT',
      url: `/v3/gn/pix/${idEnvio}`,
      data: body,
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log("Resposta Efí:", response.status, response.data);
    return { idEnvio, data: response.data };
  } catch (error) {
    console.error("Erro Efí:", error.response?.status);
    console.error("Resposta Efí:", error.response?.data);
    console.error(error.message);
    throw error;
  }
}

async function enviarPixParaTrabalhadorComId({ idEnvio, chavePix, valor, descricao }) {
  const body = {
    valor: valor.toFixed(2),
    pagador: { chave: EFI_CHAVE_PIX_APP },
    favorecido: { chave: chavePix },
  };
  console.log('Body enviado para envio Pix Efi:', body);
  console.log("Enviando repasse Pix", body);
  try {
    const token = await getEfiToken();
    const client = efiClient();
    const response = await client.request({
      method: 'PUT',
      url: `/v3/gn/pix/${idEnvio}`,
      data: body,
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log("Resposta Efí:", response.status, response.data);
    return { idEnvio, data: response.data };
  } catch (error) {
    console.error("Erro Efí:", error.response?.status);
    console.error("Resposta Efí:", error.response?.data);
    console.error(error.message);
    throw error;
  }
}

app.post('/clienteConfirmouServico', async (req, res) => {
  try {
    initFirebase();
    required('EFI_CHAVE_PIX_APP', EFI_CHAVE_PIX_APP);
    const db = admin.firestore();
    const { pedidoId, clienteId } = req.body || {};
    if (!pedidoId || !clienteId) return res.status(400).json({ erro: 'Informe pedidoId e clienteId' });

    const pedidoRef = db.collection('pedidos').doc(String(pedidoId));
    const idEnvio = `REP${String(pedidoId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 32)}`;
    const repasseRef = db.collection('repasses').doc(idEnvio);

    const dadosRepasse = await db.runTransaction(async (transaction) => {
      const pedidoDoc = await transaction.get(pedidoRef);
      if (!pedidoDoc.exists) {
        const erro = new Error('Pedido nao encontrado');
        erro.status = 404;
        throw erro;
      }

      const pedido = pedidoDoc.data();
      if (pedido.clienteId !== clienteId) {
        const erro = new Error('Cliente incorreto');
        erro.status = 403;
        throw erro;
      }
      if (pedido.pago !== true) {
        const erro = new Error('Pedido ainda nao foi pago');
        erro.status = 400;
        throw erro;
      }
      if (pedido.pagamentoStatus !== 'pago_bloqueado' && pedido.pagamentoStatus !== 'aguardando_confirmacao_cliente') {
        const erro = new Error('Pagamento nao esta bloqueado para repasse');
        erro.status = 400;
        throw erro;
      }
      if (pedido.trabalhadorFinalizou !== true && pedido.servicoFinalizadoPeloPrestador !== true) {
        const erro = new Error('Trabalhador ainda nao finalizou o servico');
        erro.status = 400;
        throw erro;
      }
      if (pedido.repasseTrabalhadorStatus === 'concluido' || pedido.pagamentoStatus === 'repasse_concluido') {
        return { jaConcluido: true, pedido };
      }
      if (pedido.repasseTrabalhadorStatus === 'processando') {
        const erro = new Error('Repasse ja esta em processamento');
        erro.status = 409;
        throw erro;
      }

      const valorTotal = dinheiro2(pedido.valorTotal || pedido.valorServico || 0);
      if (!valorTotal || valorTotal <= 0) {
        const erro = new Error('Pedido sem valor para repasse');
        erro.status = 400;
        throw erro;
      }

      const comissaoApp = dinheiro2(valorTotal * APP_COMISSAO);
      const valorTrabalhador = dinheiro2(valorTotal - comissaoApp);
      const prestadorId = pedido.prestadorId || pedido.aceitoPor;
      if (!prestadorId) {
        const erro = new Error('Pedido sem trabalhador definido');
        erro.status = 400;
        throw erro;
      }

      transaction.set(pedidoRef, {
        status: 'concluido_processando_repasse',
        clienteConfirmouServico: true,
        clienteConfirmouFinalizacao: true,
        clienteConfirmouEm: agora(),
        repasseTrabalhadorStatus: 'processando',
        repasseTrabalhadorIdEnvio: idEnvio,
        valorTotal,
        comissaoApp,
        valorTrabalhador,
        valorPrestador: valorTrabalhador,
        atualizadoEm: agora(),
      }, { merge: true });

      transaction.set(repasseRef, {
        pedidoId: String(pedidoId),
        clienteId,
        prestadorId,
        valorTotal,
        comissaoApp,
        valorTrabalhador,
        gateway: 'efi',
        efiIdEnvio: idEnvio,
        status: 'processando',
        criadoEm: agora(),
        atualizadoEm: agora(),
      }, { merge: true });

      return { pedido, prestadorId, valorTotal, comissaoApp, valorTrabalhador };
    });

    if (dadosRepasse.jaConcluido) {
      return res.json({ sucesso: true, mensagem: 'Servico ja confirmado e repasse ja concluido.' });
    }

    const { prestadorId, valorTotal, comissaoApp, valorTrabalhador } = dadosRepasse;
    const userDoc = await db.collection('usuarios').doc(String(prestadorId)).get();
    const trabalhador = userDoc.data() || {};
    const chavePix = String(trabalhador.chavePix || trabalhador.pix || trabalhador.pixChave || '').trim();
    if (!chavePix) return res.status(400).json({ erro: 'Trabalhador nao possui chave Pix cadastrada.' });

    const repasse = await enviarPixParaTrabalhadorComId({
      idEnvio,
      chavePix,
      valor: valorTrabalhador,
      descricao: `Repasse pedido ${pedidoId} - Faz Pra Mim`,
    });

    await repasseRef.set({
      pedidoId: String(pedidoId), clienteId, prestadorId,
      valorTotal, comissaoApp, valorTrabalhador,
      chavePixTrabalhador: chavePix,
      gateway: 'efi', status: 'concluido',
      efiIdEnvio: repasse.idEnvio,
      efiResposta: repasse.data,
      atualizadoEm: agora(),
    }, { merge: true });

    await pedidoRef.set({
      status: 'concluido',
      pagamentoStatus: 'repasse_concluido',
      dinheiroRetidoAteConfirmacao: false,
      repasseTrabalhadorStatus: 'concluido',
      repasseTrabalhadorIdEnvio: repasse.idEnvio,
      repasseTrabalhadorEm: agora(),
      servicoConcluido: true,
      avaliacaoPendente: true,
      finalizadoEm: agora(),
      concluidoEm: agora(),
      valorTotal, comissaoApp, valorTrabalhador,
      valorPrestador: valorTrabalhador,
      atualizadoEm: agora(),
    }, { merge: true });

    await criarNotificacao(db, prestadorId, 'Pagamento recebido', `Seu repasse de R$ ${valorTrabalhador.toFixed(2).replace('.', ',')} foi enviado por Pix.`, 'repasse_concluido', String(pedidoId));

    res.json({ sucesso: true, mensagem: 'Servico confirmado e repasse enviado.', valorTotal, comissaoApp, valorTrabalhador });
  } catch (e) {
    console.error('clienteConfirmouServico erro', e?.response?.data || e.message);
    try {
      if (req.body?.pedidoId) {
        await admin.firestore().collection('pedidos').doc(String(req.body.pedidoId)).set({
          repasseTrabalhadorStatus: 'erro',
          repasseTrabalhadorErro: JSON.stringify(e?.response?.data || e.message).slice(0, 900),
          atualizadoEm: agora(),
        }, { merge: true });
      }
    } catch (_) {}
    res.status(e.status || 500).json({ erro: 'Erro ao confirmar servico ou enviar Pix', detalhes: e?.response?.data || e.message });
  }
});
app.listen(PORT, () => console.log(`Faz Pra Mim Efí backend rodando na porta ${PORT}`));
