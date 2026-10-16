## Licença e Atribuição

Este projeto é licenciado sob a **Apache License 2.0**.  
Você **deve** manter o crédito visível:

> “Este produto inclui software desenvolvido pela Zaptos (https://zaptoswpp.com).”

Consulte [LICENSE](./LICENSE) e [NOTICE](./NOTICE).  
Uso de marca: veja [TRADEMARKS.md](./TRADEMARKS.md).

## Templates oficiais com mídia

Em `src/zaptos-actions-original.js`, o criador de templates aceita cabeçalhos de
imagem (JPEG/PNG, até 5 MB), vídeo (MP4, até 16 MB) e documento (PDF, até 100 MB).
O arquivo escolhido na criação serve de exemplo para a análise da Meta. No seletor
de templates aprovados, o usuário escolhe o arquivo que será anexado à conversa,
preenche os parâmetros e clica em **Usar template**. O envio final continua manual,
depois que o upload do anexo aparecer no compositor do CRM.

Para publicar este recurso, atualize nesta ordem:

1. O gateway `zaptos-api/api-oficial` com a rota `POST /{version}/{waba_id}/template_media`.
2. A Edge Function `get-waba-templates`, usando
   `src/supabase/functions/edge-fcuntions/get-waba-templates.ts`.
3. O script carregado no CRM. Se usar uma versão minificada/ofuscada, gere-a novamente
   com `src/build-zaptos-actions-criptografado.ps1`, executado na pasta `src`.

A Edge Function recebe `multipart/form-data` com `payload` (JSON do `create_template`)
e `media` (arquivo). O gateway recebe o binário com `file_name`, `file_length` e
`file_type` na query, exige `templates:write` e valida o acesso à WABA antes de
executar o upload. O `h` retornado pela Meta entra em `example.header_handle`.
As credenciais permanecem no backend. Templates sem mídia continuam usando JSON.

Referências oficiais: [upload de exemplos](https://www.postman.com/meta/whatsapp-business-platform/request/vkmioqf/resumable-upload-create-an-upload-session)
e [template com documento](https://www.postman.com/meta/whatsapp-business-platform/request/ep5w4rc/create-template-w-document-header-text-body-a-phone-number-button-and-a-url-button).

Validação local: `deno test --allow-read --allow-env tests/template-media.test.ts`.
Os testes usam respostas simuladas; a aprovação real depende do ambiente publicado
e da análise da Meta.

## Variáveis da GHL nos templates e workflows

Os parâmetros aceitam merge fields como `{{contact.first_name}}`, `{{contact.phone}}`
e `{{ custom_values.calendar_link }}`. Quando há variáveis, o script gera
`#templateparams:ghl1:...` com os valores em blocos de texto delimitados. Assim, a
GHL pode substituí-los ao enviar a mensagem, inclusive em execuções futuras do
workflow. Aspas e quebras de linha nos valores não precisam de escape JSON.
Parâmetros fixos continuam usando o formato Base64URL anterior.
Os novos blocos usam delimitadores neutros `--template-...--`. O receptor mantém
compatibilidade com os delimitadores antigos para ações que já foram salvas.

O receptor reconstrói e valida os parâmetros antes de interpretar outros comandos.
Uma variável que chegar sem substituição gera `OFFICIAL_TEMPLATE_VARIABLE_UNRESOLVED`,
em vez de ser entregue literalmente ao WhatsApp.

Em `/automation/workflow/<id>`, o botão **Templates** aparece ao lado de **Escreva
com AI** no nó SMS. **Usar template** preenche a mensagem desse nó; é necessário
clicar em **Salvar ação** para persistir a alteração. O script não salva nem publica
o workflow automaticamente.
O atalho é montado pelo cabeçalho do SMS, mesmo enquanto o editor carrega. A escrita
usa o TipTap de `.ghl-workflow-text-editor` no painel `[data-action-type="sms"]`,
sem selecionar o editor de URL dos anexos.

Publicação necessária, nesta ordem:

1. Atualize a função receptora com `ghl_in-redis.ts` do repositório
   `zaptoswppSupabase`, incluindo `prepareOfficialTemplateTransport`.
2. Atualize o script do CRM; as versões minificada/ofuscada são geradas por
   `src/build-zaptos-actions-criptografado.ps1`. O build também atualiza
   `src/zaptos-actions.js` com a mesma versão ofuscada. Se o código estiver colado
   diretamente no JavaScript personalizado da GHL, substitua esse conteúdo.
3. Gere novamente os comandos de templates que já tinham variáveis escondidas
   em Base64 e salve as respectivas ações. Comandos antigos não são migrados
   automaticamente.

Validação do frontend: `deno test --allow-read --allow-env tests/template-media.test.ts tests/template-ghl.test.ts`.
No repositório do receptor: `node --test tools/official-template-ghl.test.mjs`.
Os testes simulam a substituição da GHL e o DOM do editor; o envio real deve ser
verificado no CRM após a publicação dos dois arquivos.

Após atualizar o script, recarregue a página para encerrar a instância anterior.
No Console, `window._zaptosMessageActions.version` deve retornar `2026.10.08.1`.
Os testes verificam o botão de SMS nas quatro distribuições, incluindo
`zaptos-actions.js`, para evitar que esse arquivo fique numa versão antiga.


## Botões de link e opções de menu

O gerador mantém botões de resposta, URL, ligação e cópia em `#send:menu`.
As opções são transportadas em `#choices:["Texto|destino", ...]` para preservar
vírgulas, aspas e barras. Carrossel só é gerado pela ação **Enviar carrossel**.

Esta versão exige publicar primeiro o receptor `zaptoswppSupabase/ghl_in-redis.ts`
atualizado, que aceita `#choices` em JSON e continua lendo comandos antigos com
`#select`. Depois, atualize o script carregado no CRM e gere novamente os comandos
de menu afetados; ações salvas anteriormente não são alteradas automaticamente.

O campo **API da instância que fará o envio** usa cartões de seleção e começa em Não oficial. Ele valida
as combinações antes de habilitar copiar, inserir ou enviar: no modo Oficial,
recusa múltiplos links, link misturado com resposta, ligação/cópia e enquete.
Essa seleção não altera a instância de destino; para uma instância Oficial,
selecione explicitamente esse modo. Comandos digitados à mão continuam sendo
validados pelo receptor, com orientação específica em caso de combinação inválida.

Na API não oficial, URLs, `call:` e `copy:` seguem o formato de `/send/menu`.
No receptor oficial, um único link é convertido em `interactive.type: cta_url`;
botões de resposta continuam limitados a três. Misturar link com respostas ou
usar ligação/cópia nesse menu oficial gera erro explícito; use templates para
os tipos de botão que exigem esse formato.

Teste de integração sem envio real (Node 24+, com o checkout `zaptoswppSupabase`
ao lado deste repositório): `node --test tests/menu-actions.test.mjs`.
Para outro caminho, configure `ZAPTOS_RECEIVER_SOURCE` com o arquivo `ghl_in-redis.ts`.

## Encaminhar mensagens entre contatos

A versão `2026.10.16.3` de `src/zaptos-actions-original.js` adiciona **Encaminhar
Mensagem** ao menu. O usuário vê a prévia, pesquisa por nome ou telefone na
subconta atual, seleciona o destinatário e confirma. A busca retorna até 20
contatos; refine o termo para localizar outros. Ao abrir, o seletor lista os contatos
das 20 conversas mais recentes, sem repetir o mesmo contato. Limpar a busca volta
a essa lista. Se a instalação não tiver permissão para listar conversas, mostra
contatos como alternativa; uma falha na listagem não bloqueia a busca. O rascunho
aberto é preservado.

Toda a funcionalidade está na Edge Function dedicada `forward-ghl-message`:
validação da sessão, busca, leitura da mensagem, registro no histórico e envio
direto ao provedor de WhatsApp. **Não chama, não importa e não exige alterações
em `ghl_in-redis.ts`**, nem utiliza sua fila. A chave de serviço do Supabase não é
encaminhada a outro endpoint; é usada somente pelo cliente de banco no servidor.

O fluxo aceita texto e até 10 anexos HTTPS de mensagens enviadas ou recebidas já
sincronizadas na tabela `messages`. Mensagens com falha, agendadas, pendentes,
comandos enviados pelo gerador de ações e avisos do sistema não são encaminhados.
Templates e elementos interativos não são recriados. Anexos devem continuar
acessíveis ao provedor. A extensão da URL determina imagem, vídeo ou áudio; URLs
sem extensão reconhecida são enviadas como documento. Legendas de áudio e textos
com múltiplos anexos são enviados em mensagem separada.

A função seleciona o canal atribuído ao usuário, depois o canal associado ao
contato, depois o canal principal ou o único disponível. Configurações ambíguas
exigem definir um canal; não há escolha aleatória. A consulta às instâncias segue
a configuração existente `INSTANCE_DELETION_ASYNC_ENABLED` para a view de canais
ativos. Na API não oficial, envia `forward: true`. Na oficial, reenvia o conteúdo
pela API do gateway, respeitando as regras desse canal, inclusive a janela de
atendimento. Credenciais de canal são lidas e usadas somente no servidor.

Publicação:

1. Execute `src/supabase/migrations/20261016_ghl_message_forwards.sql`. Ela também
   adiciona `provider_message_ids` caso a primeira revisão já tenha sido aplicada.
2. Publique `src/supabase/functions/edge-fcuntions/forward-ghl-message.ts` como
   **forward-ghl-message**, com os secrets abaixo. Desative a verificação JWT do
   gateway **somente nessa função** (`verify_jwt = false`); ela própria valida o
   contexto criptografado da GHL antes de acessar dados.
3. Atualize o script original no CRM. Se usar a distribuição ofuscada, gere-a
   primeiro com `src/build-zaptos-actions-criptografado.ps1`. Recarregue a página.
4. Valide texto, imagem, áudio e documento entre contatos de teste na GHL.

| Secret | Valor |
| --- | --- |
| `GHL_APP_ID` | ID público do aplicativo Zaptos instalado |
| `GHL_APP_SHARED_SECRET` | Shared Secret do aplicativo; somente no servidor |
| `GHL_CONVERSATION_PROVIDER_ID` | ID do provedor SMS do Zaptos |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Variáveis padrão do projeto |
| `ZAPTOS_LOCAL_DATA_KEY` | Chave existente para descriptografar credenciais de canais oficiais, se utilizados |
| `META_GRAPH_VERSION` | Opcional, padrão `v25.0`, para canais oficiais |

`ZAPTOS_FORWARD_RECEIVER_URL` não é utilizado e pode ser removido, caso tenha sido
configurado para a versão anterior. Não é necessário publicar o receptor principal.
Para outro projeto, configure `window.__ZAPTOS_FORWARD_EDGE_URL__` antes do script.

O navegador usa `window.exposeSessionDetails(APP_ID)`. A função valida a sessão e
exige que a subconta corresponda ao contexto autenticado. O aplicativo precisa dos
escopos `contacts.readonly`, `conversations.readonly` (conversas recentes),
`conversations/message.readonly` e
`conversations/message.write`, com token válido em `code_autorization_ghl`. O
endpoint de configuração retorna somente o ID público do aplicativo.

O histórico é registrado por `POST /conversations/messages/inbound` com direção
`outbound`, sem o campo `status` (não documentado nesse endpoint) e sem campos
opcionais de conteúdo vazios. Em seguida, a função envia diretamente ao canal e
salva os IDs retornados pelo provedor. Sucesso significa **aceito pelo provedor**,
não confirmação de entrega ao destinatário. A função não marca como entregue
apenas com o aceite; recibos de entrega continuam dependendo da integração de
webhooks do provedor com o histórico da GHL.

`ghl_message_forwards` mantém idempotência e recibos de cada parte. Somente a chave
de serviço acessa a tabela. Estados: `submitting` (registro ainda não confirmado),
`registered` (histórico criado), `dispatching` (envio assumido atomicamente),
`accepted` (todas as partes aceitas pelo provedor). **Verificar resultado** usa o
mesmo ID e não repete registros nem envios já assumidos. Se houver timeout, falha
ou aceite parcial, confira a conversa e `provider_message_ids` antes de criar
outra solicitação. Não existe repetição automática de envios incertos.

Testes do recurso, independentes do repositório do receptor (Node 24+):

```sh
npm ci --prefix tests
node --test tests/forward-message.test.mjs
```

Os testes simulam a GHL e os provedores, incluindo sessão, isolamento entre
subcontas, idempotência, texto/mídia, pesquisa assíncrona e cancelamento. Não enviam
mensagens reais; a validação final deve ocorrer no CRM publicado.

Referências: [sessão da GHL](https://marketplace.gohighlevel.com/docs/other/user-context-marketplace-apps/index.html),
[busca de contatos](https://marketplace.gohighlevel.com/docs/ghl/contacts/search-contacts-advanced/)
e [registro no histórico](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/conversations/add-an-inbound-message/).


Erros da GHL no encaminhamento agora retornam `operation` e `upstreamStatus`,
identificando a etapa (`read_message`, `search_contacts`, `recent_conversations`,
`read_contact` ou `register_message`) e o HTTP original. Logs registram apenas
etapa/status, sem corpo de resposta, dados de contatos ou credenciais. Atualize a
Edge Function **e** o script original para receber o diagnóstico e a lista inicial.
A mensagem genérica antiga `ghl_error` não permite determinar a causa de uma falha
já ocorrida; é necessário obter o novo diagnóstico no ambiente publicado.

Para a rejeição HTTP 422 em `register_message`, republique somente
`forward-ghl-message.ts` atualizado e reabra o modal para iniciar outra solicitação.
O ajuste remove `status` do registro e omite texto/anexos vazios. Isso corrige o
formato enviado, mas o HTTP 422 anterior não identifica sozinho o campo recusado.
Erros de validação reconhecidos agora incluem `validationIssues`, com nomes de
campos e regras de uma lista fixa, sem valores ou texto bruto da GHL. A confirmação
da correção depende de testar na subconta após publicar.
