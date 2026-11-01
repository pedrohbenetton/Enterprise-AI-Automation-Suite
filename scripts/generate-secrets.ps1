# Cria o .env a partir do .env.example, trocando cada "change-me" por um segredo aleatório distinto.
# Uso (PowerShell):  .\scripts\generate-secrets.ps1          (não sobrescreve um .env existente)
#                    .\scripts\generate-secrets.ps1 -Force
param([switch]$Force)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$example = Join-Path $root '.env.example'
$target = Join-Path $root '.env'

if ((Test-Path $target) -and -not $Force) {
    Write-Error '.env já existe — nada feito. Use -Force para regenerar (invalida Credentials salvas no n8n!).'
}

function New-RandomHex {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

$lines = Get-Content $example | ForEach-Object {
    if ($_ -match '^([A-Z0-9_]+)=change-me$') { "$($Matches[1])=$(New-RandomHex)" } else { $_ }
}
# UTF-8 sem BOM e LF: o docker compose lê o arquivo como texto POSIX
[System.IO.File]::WriteAllText($target, (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding $false))

Write-Host ".env criado com segredos aleatórios em: $target"
Write-Host 'Guarde o N8N_ENCRYPTION_KEY: sem ele as Credentials do n8n não podem ser decifradas.'
