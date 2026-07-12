BACKEND FAZ PRA MIM - ASAAS PIX NO RENDER

Variaveis de ambiente obrigatorias no Render:
ASAAS_API_KEY=sua_api_key_do_asaas
ASAAS_PIX_KEY=sua_chave_pix_do_asaas
FIREBASE_SERVICE_ACCOUNT_BASE64=service_account_json_em_base64
APP_COMISSAO=0.10

Opcional:
ASAAS_BASE_URL=https://api.asaas.com/v3
PORT=3000

Rotas principais:
POST /criarPagamentoPix
POST /criarPagamentoPixAsaas
POST /webhookAsaas
POST /verificarPagamentoAsaas
POST /repassarTrabalhadorAsaas
POST /clienteConfirmouServico

Webhook no Asaas:
Configure a URL publica do Render como:
https://SEU-SERVICO.onrender.com/webhookAsaas

O backend cria cobrancas Pix no endpoint /v3/payments com billingType=PIX,
envia a API key pelo header access_token e grava no Firestore os campos de
pagamento e confirmacao recebidos pelo webhook.
