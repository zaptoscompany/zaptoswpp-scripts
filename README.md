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
No Console, `window._zaptosMessageActions.version` deve retornar `2026.10.07.2`.
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

Na API não oficial, URLs, `call:` e `copy:` seguem o formato de `/send/menu`.
No receptor oficial, um único link é convertido em `interactive.type: cta_url`;
botões de resposta continuam limitados a três. Misturar link com respostas ou
usar ligação/cópia nesse menu oficial gera erro explícito; use templates para
os tipos de botão que exigem esse formato.

Teste de integração sem envio real (Node 24+, com o checkout `zaptoswppSupabase`
ao lado deste repositório): `node --test tests/menu-actions.test.mjs`.
Para outro caminho, configure `ZAPTOS_RECEIVER_SOURCE` com o arquivo `ghl_in-redis.ts`.
