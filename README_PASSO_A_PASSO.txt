FAZ PRA MIM - BACKEND RENDER + EFÍ PIX AUTOMÁTICO

Este pacote substitui o Cloudflare Worker para a parte financeira da Efí.
Motivo: o Cloudflare recusou o certificado mTLS da Efí. O Render aceita o .p12 direto.

O QUE ESTE BACKEND FAZ:
1. Cria Pix pela Efí.
2. Retorna QR Code / Pix copia e cola para o app Flutter.
3. Recebe webhook da Efí quando o Pix é pago.
4. Marca o pedido como pago_bloqueado no Firestore.
5. Mantém o dinheiro na conta Efí do app.
6. Quando o trabalhador finaliza e o cliente confirma, envia 90% por Pix para a chave Pix do trabalhador.
7. Registra a comissão de 10% para o app.

ATENÇÃO SOBRE SEGURANÇA:
Nunca envie Client Secret, certificado .p12 nem service account do Firebase no chat.
Configure tudo em Environment Variables no Render.

VARIÁVEIS NECESSÁRIAS NO RENDER:
EFI_BASE_URL=https://pix.api.efipay.com.br
EFI_CLIENT_ID=seu_client_id_producao
EFI_CLIENT_SECRET=seu_client_secret_producao
EFI_CHAVE_PIX_APP=sua_chave_pix_da_conta_efi
EFI_CERT_BASE64=conteudo_base64_do_arquivo efi_producao.p12
EFI_CERT_PASSWORD= deixe vazio se o certificado não tiver senha
FIREBASE_SERVICE_ACCOUNT_BASE64=service_account_json_em_base64
APP_COMISSAO=0.10

COMO GERAR EFI_CERT_BASE64 NO WINDOWS:
No CMD:
certutil -encode C:\Users\valmi\faz_pra_mim\functions\certs\efi_producao.p12 C:\Users\valmi\faz_pra_mim\functions\certs\efi_cert_base64.txt
Abra o arquivo e copie o conteúdo, removendo as linhas:
-----BEGIN CERTIFICATE-----
-----END CERTIFICATE-----
Cole no Render como EFI_CERT_BASE64.

COMO GERAR FIREBASE_SERVICE_ACCOUNT_BASE64:
1. Firebase Console > Project settings > Service accounts.
2. Generate new private key.
3. Salve o JSON no seu PC.
4. Rode:
certutil -encode caminho\arquivo-firebase.json firebase_service_base64.txt
5. Copie o conteúdo sem as linhas BEGIN/END e cole em FIREBASE_SERVICE_ACCOUNT_BASE64.

COMANDOS LOCAIS PARA TESTAR:
npm install
npm start

ENDPOINTS:
GET  /health
POST /criarPagamentoPix
POST /webhookPixEfi
POST /trabalhadorEstouIndo
POST /prestadorFinalizouServico
POST /clienteConfirmouServico

NO FLUTTER:
Troque a URL antiga do Cloudflare/Firebase para a URL do Render:
https://SEU-SERVICO.onrender.com/criarPagamentoPix

WEBHOOK EFÍ:
Configure a chave Pix da Efí para webhook:
https://SEU-SERVICO.onrender.com/webhookPixEfi

OBSERVAÇÃO:
Se o Pix de envio falhar, pode ser limite/permissão de Cash-Out da Efí. Aí precisa pedir liberação/aumento no suporte Efí.
