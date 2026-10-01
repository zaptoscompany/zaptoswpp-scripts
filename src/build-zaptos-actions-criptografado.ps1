$ErrorActionPreference = "Stop"

$src = "zaptos-actions-original.js"
$min = "zaptos-actions-Criptografado.min.js"
$out = "zaptos-actions-Criptografado.js"
$public = "zaptos-actions.js"

if (-not (Test-Path $src)) {
  throw "Arquivo nao encontrado: $src"
}

Write-Host "[1/3] Minificando $src -> $min"
npx.cmd --yes terser $src -c -m --comments false -o $min
if ($LASTEXITCODE -ne 0) { throw "Falha ao minificar $src" }

Write-Host "[2/3] Ofuscando $min -> $out"
npx.cmd --yes javascript-obfuscator $min `
  --output $out `
  --compact true `
  --identifier-names-generator hexadecimal `
  --rename-globals false `
  --string-array true `
  --string-array-encoding base64 `
  --string-array-threshold 0.75 `
  --split-strings true `
  --split-strings-chunk-length 8 `
  --transform-object-keys true `
  --disable-console-output false `
  --self-defending false `
  --dead-code-injection false `
  --control-flow-flattening false
if ($LASTEXITCODE -ne 0) { throw "Falha ao ofuscar $min" }

Write-Host "[3/3] Atualizando $public"
Copy-Item -LiteralPath $out -Destination $public -Force

Write-Host "Build concluido:"
Write-Host " - $min"
Write-Host " - $out"
Write-Host " - $public"
