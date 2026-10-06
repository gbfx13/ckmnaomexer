# CKM Multiservices: site + notificação de orçamento

Site da CKM Multiservices LLC com o formulário "Request a Free Estimate" ligado a um backend que:

1. **Salva** cada pedido no banco de dados (Supabase / Postgres).
2. **Envia um e-mail para a empresa** (`ckmmultiservicess@gmail.com`) com o assunto
   **New Free Estimate Request - CKM Multiservices**. O e-mail traz todos os dados do cliente, lista as fotos enviadas e vai com elas em anexo.
3. **Envia uma confirmação automática para o cliente** com o assunto
   **We Received Your Estimate Request - CKM Multiservices**, no idioma que ele usou no site (EN, PT ou ES).

Nenhuma senha ou chave fica no código do site. Tudo vem de **variáveis de ambiente** no servidor.

---

## Estrutura

```
index.html               o site (o formulário envia para /api/estimate)
photos/  art/            fotos reais e ilustrações
api/estimate.js          função de servidor: recebe o formulário, salva e envia os e-mails
supabase/schema.sql      cria a tabela estimate_requests
.env.example             lista das variáveis de ambiente (sem valores reais)
vercel.json              configuração da hospedagem
build-from-artifact.py   regenera o index.html a partir da versão de prévia
```

---

## Passo a passo para colocar no ar (Vercel)

### 1. Senha de app do Gmail (para enviar os e-mails)
1. Entre na conta **ckmmultiservicess@gmail.com**.
2. Ative a **verificação em duas etapas** (Conta Google → Segurança).
3. Vá em **Conta Google → Segurança → Senhas de app**, crie uma chamada "Site CKM" e copie a senha de 16 letras.
   Ela vai em `SMTP_PASS`. Não é a senha normal do Gmail.

### 2. Banco de dados (Supabase, plano gratuito)
1. Crie um projeto em supabase.com.
2. Abra **SQL Editor**, cole o conteúdo de `supabase/schema.sql` e rode.
3. Em **Project Settings → API**, copie:
   - **Project URL** → `SUPABASE_URL`
   - **service_role key** → `SUPABASE_SERVICE_ROLE_KEY` (é secreta: só no servidor)

Os pedidos ficam em **Table Editor → estimate_requests**. A coluna `status` serve para marcar o andamento (new, contacted, scheduled, closed).

### 3. Publicar
1. Suba esta pasta para um repositório no GitHub.
2. Em vercel.com: **Add New → Project**, escolha o repositório e clique em Deploy (não precisa de build).
3. Em **Settings → Environment Variables**, cadastre as variáveis do `.env.example` com os valores reais:

| Variável | Valor |
|---|---|
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `465` |
| `SMTP_SECURE` | `true` |
| `SMTP_USER` | `ckmmultiservicess@gmail.com` |
| `SMTP_PASS` | senha de app do passo 1 |
| `MAIL_FROM` | `CKM Multiservices <ckmmultiservicess@gmail.com>` |
| `NOTIFY_TO` | `ckmmultiservicess@gmail.com` |
| `SUPABASE_URL` | do passo 2 |
| `SUPABASE_SERVICE_ROLE_KEY` | do passo 2 |

4. Faça **Redeploy** para as variáveis valerem.
5. Teste: preencha o formulário no site com seu próprio e-mail. Devem chegar os dois e-mails, e o pedido aparece na tabela.

> Outro provedor de e-mail? Qualquer serviço SMTP funciona (Outlook, Zoho, SendGrid, Resend etc.): basta trocar `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` e `SMTP_PASS`.

---

## Como funciona

- **Validação dupla:** os campos são conferidos no navegador e de novo no servidor. Os serviços só aceitam as 5 opções oficiais.
- **Fotos:** o navegador reduz cada foto para no máximo 1600 px antes de enviar, o que deixa o envio rápido no celular. O servidor aceita até 10 imagens, 4 MB no total, e anexa ao e-mail da empresa.
- **Anti-spam:** um campo invisível (honeypot) descarta envios de robôs sem avisar.
- **Se o banco falhar:** o e-mail para a empresa sai mesmo assim, para o pedido não se perder, e o erro fica registrado nos logs da Vercel.
- **Se o e-mail para a empresa falhar:** o visitante vê uma mensagem pedindo para ligar para +1 (321) 240-0711.
- **Responder o cliente:** no e-mail da empresa, basta clicar em Responder, porque o "Reply-To" já é o e-mail do cliente.

## Segurança
- `SMTP_PASS` e `SUPABASE_SERVICE_ROLE_KEY` existem **somente** nas variáveis de ambiente do servidor.
- O `index.html` não contém nenhuma chave. Nunca coloque um arquivo `.env` com valores reais no GitHub.
- A tabela tem RLS ativado: ninguém lê os pedidos pelo site, só pelo painel do Supabase.
