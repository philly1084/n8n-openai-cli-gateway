param(
  [string]$Namespace = "n8n-openai-gateway",
  [string]$ConfigMapName = "n8n-openai-cli-gateway-config",
  [string]$DeploymentName = "n8n-openai-cli-gateway",
  [string]$SecretName = "n8n-openai-cli-gateway-groq",
  [string]$GroqApiKey = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

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
            -d "$(printf '{"model":"%s","messages":[{"role":"user","content":%s}],"stream":false}' "{{provider_model}}" "$(printf "%s" "$PROMPT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.stringify(String(d))));')")" | \
            node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const out={output_text:"",tool_calls:[],finish_reason:"stop"};try{const res=JSON.parse(d);const choice=Array.isArray(res.choices)&&res.choices[0]&&typeof res.choices[0]==="object"?res.choices[0]:{};const msg=choice.message&&typeof choice.message==="object"?choice.message:{};const extractText=(content)=>{if(typeof content==="string") return content.trim();if(Array.isArray(content)){return content.map(part=>{if(typeof part==="string") return part;if(part&&typeof part==="object"){if(typeof part.text==="string") return part.text;if(typeof part.content==="string") return part.content;}return "";}).filter(Boolean).join("\n").trim();}if(content&&typeof content==="object"){if(typeof content.text==="string") return content.text.trim();if(typeof content.content==="string") return content.content.trim();}return "";};const content=extractText(msg.content);const toolCalls=Array.isArray(msg.tool_calls)?msg.tool_calls.map((call,i)=>{if(!call||typeof call!=="object") return null;const fn=call.function&&typeof call.function==="object"?call.function:{};const name=typeof fn.name==="string"?fn.name.trim():"";if(!name) return null;const args=typeof fn.arguments==="string"?fn.arguments:JSON.stringify(fn.arguments??{});return {id:typeof call.id==="string"&&call.id?call.id:`call_${i+1}`,name,arguments:args};}).filter(Boolean):[];const finish=typeof choice.finish_reason==="string"&&choice.finish_reason?choice.finish_reason:(toolCalls.length>0?"tool_calls":"stop");out.output_text=content;out.tool_calls=toolCalls;out.finish_reason=finish;}catch(e){out.output_text=d.trim();}process.stdout.write(JSON.stringify(out));});'
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

$providersYaml = kubectl get configmap $ConfigMapName -n $Namespace -o jsonpath='{.data.providers\.yaml}'
if (-not $providersYaml) {
  throw "providers.yaml was empty or could not be fetched from ConfigMap $ConfigMapName in namespace $Namespace"
}

$groqBlockPattern = '(?ms)^  - id: groq-api\r?\n.*?(?=^  - id: |\z)'
if ($providersYaml -match $groqBlockPattern) {
  $updatedProvidersYaml = [regex]::Replace($providersYaml, $groqBlockPattern, $groqProviderBlock + "`n")
  Write-Host "Replaced existing groq-api block."
} else {
  $updatedProvidersYaml = $providersYaml.TrimEnd("`r", "`n") + "`r`n`r`n" + $groqProviderBlock + "`r`n"
  Write-Host "Appended groq-api block."
}

$tmpFile = [System.IO.Path]::GetTempFileName()
try {
  Set-Content -LiteralPath $tmpFile -Value $updatedProvidersYaml -NoNewline

  kubectl create configmap $ConfigMapName `
    -n $Namespace `
    --from-file=providers.yaml=$tmpFile `
    --dry-run=client `
    -o yaml | kubectl apply -f -

  if ($GroqApiKey) {
    kubectl create secret generic $SecretName `
      -n $Namespace `
      --from-literal=GROQ_API_KEY=$GroqApiKey `
      --dry-run=client `
      -o yaml | kubectl apply -f -

    kubectl set env deployment/$DeploymentName `
      -n $Namespace `
      --containers=gateway `
      --from=secret/$SecretName
  }

  kubectl rollout restart deployment/$DeploymentName -n $Namespace
  kubectl rollout status deployment/$DeploymentName -n $Namespace --timeout=180s
} finally {
  Remove-Item -LiteralPath $tmpFile -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Retest with:"
Write-Host "kubectl exec -n $Namespace deploy/$DeploymentName -- sh -lc 'curl -s http://localhost:8080/v1/chat/completions -H ""Content-Type: application/json"" -H ""x-api-key: `$N8N_API_KEY"" -d ""{`"model`":`"llama-3.3-70b-versatile`",`"messages`":[{`"role`":`"user`",`"content`":`"Reply with exactly hello`"}]}""'"
