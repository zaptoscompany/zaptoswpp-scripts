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
