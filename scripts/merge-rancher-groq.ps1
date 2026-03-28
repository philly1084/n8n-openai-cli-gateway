param(
  [string]$InputPath = "kubernetes/rancher-install.yaml",
  [string]$OutputPath = "kubernetes/rancher-install-groq.yaml",
  [string]$GroqApiKey = "replace-with-groq-api-key"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $InputPath)) {
  throw "Input file not found: $InputPath"
}

$content = Get-Content -LiteralPath $InputPath -Raw

$groqSecretLine = "  groqApiKey: `"$GroqApiKey`""
$groqEnvBlock = @"
            - name: GROQ_API_KEY
              valueFrom:
                secretKeyRef:
                  name: n8n-openai-cli-gateway-secrets
                  key: groqApiKey
"@

$groqProviderBlock = @"

      - id: groq-api
        type: cli
        description: Groq API via curl using Groq production chat models
        models:
          - id: groq/compound
            providerModel: groq/compound
            fallbackModels:
              - openai/gpt-oss-20b
              - llama-3.3-70b-versatile
          - id: groq/compound-mini
            providerModel: groq/compound-mini
            fallbackModels:
              - openai/gpt-oss-20b
          - id: openai/gpt-oss-120b
            providerModel: openai/gpt-oss-120b
            fallbackModels:
              - openai/gpt-oss-20b
              - llama-3.3-70b-versatile
          - id: openai/gpt-oss-20b
            providerModel: openai/gpt-oss-20b
            fallbackModels:
              - llama-3.1-8b-instant
          - id: llama-3.3-70b-versatile
            providerModel: llama-3.3-70b-versatile
            fallbackModels:
              - openai/gpt-oss-20b
              - llama-3.1-8b-instant
          - id: llama-3.1-8b-instant
            providerModel: llama-3.1-8b-instant
          # Preview models from Groq docs. Uncomment if you want them exposed.
          # - id: meta-llama/llama-4-scout-17b-16e-instruct
          #   providerModel: meta-llama/llama-4-scout-17b-16e-instruct
          # - id: qwen/qwen3-32b
          #   providerModel: qwen/qwen3-32b
        responseCommand:
          executable: sh
          args:
            - -lc
            - |
              REQUEST_JSON="$(cat)"
              PROMPT="$(
                printf "%s" "$REQUEST_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const req=JSON.parse(d);const msgs=Array.isArray(req.messages)?req.messages:[];const norm=v=>typeof v==="string"?v:JSON.stringify(v??"");const text=msgs.map(m=>{const role=String(m&&m.role?m.role:"user").toUpperCase();const content=norm(m&&Object.prototype.hasOwnProperty.call(m,"content")?m.content:"");return role+":\n"+content;}).join("\n\n");process.stdout.write((typeof req.prompt==="string"&&req.prompt.trim()?req.prompt:text).trim());}catch{process.stdout.write("");}});'
              )"
              curl -fsS https://api.groq.com/openai/v1/chat/completions \
                -H "Authorization: Bearer $GROQ_API_KEY" \
                -H "Content-Type: application/json" \
                -d "$(printf '{"model":"%s","messages":[{"role":"user","content":%s}],"stream":false}' "{{provider_model}}" "$(printf "%s" "$PROMPT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.stringify(String(d))));')")"
          input: request_json_stdin
          output: json_contract
          timeoutMs: 120000
        auth:
          statusCommand:
            executable: sh
            args:
              - -lc
              - |
                test -n "${GROQ_API_KEY:-}" || { echo '{"ok":false,"error":"GROQ_API_KEY not set"}'; exit 1; }
                curl -fsS https://api.groq.com/openai/v1/models \
                  -H "Authorization: Bearer $GROQ_API_KEY" >/dev/null
                echo '{"ok":true}'
            timeoutMs: 15000
"@

if ($content -notmatch '(?m)^\s*groqApiKey:\s*') {
  $content = [regex]::Replace(
    $content,
    '(?m)^(\s*adminApiKey:\s*".*?"\s*$)',
    "`$1`r`n$groqSecretLine",
    1
  )
}

if ($content -notmatch '(?m)^\s*- name:\s*GROQ_API_KEY\s*$') {
  $content = [regex]::Replace(
    $content,
    '(?ms)(\s*- name:\s*NANOBANANA_GOOGLE_API_KEY\s*\r?\n\s*valueFrom:\s*\r?\n\s*secretKeyRef:\s*\r?\n\s*name:\s*n8n-openai-cli-gateway-secrets\s*\r?\n\s*key:\s*geminiApiKey\s*)',
    "`$1`r`n$groqEnvBlock",
    1
  )
}

if ($content -notmatch '(?m)^\s*- id:\s*groq-api\s*$') {
  $content = [regex]::Replace(
    $content,
    '(?ms)(providers\.yaml:\s*\|\s*\r?\n.*?)(\r?\n---\r?\napiVersion:\s*v1\s*\r?\nkind:\s*PersistentVolumeClaim)',
    { param($m) $m.Groups[1].Value.TrimEnd("`r", "`n") + "`r`n" + $groqProviderBlock + $m.Groups[2].Value },
    1
  )
}

Set-Content -LiteralPath $OutputPath -Value $content -NoNewline
Write-Host "Wrote merged Groq Rancher manifest to $OutputPath"
