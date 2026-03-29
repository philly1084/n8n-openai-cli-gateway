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
              PAYLOAD="$(
                printf "%s" "$REQUEST_JSON" | node -e 'let d="";const maxChars=Number(process.env.GROQ_MAX_PROMPT_CHARS||120000);process.stdin.on("data",c=>d+=c).on("end",()=>{const norm=v=>typeof v==="string"?v:JSON.stringify(v??"");try{const req=JSON.parse(d);const rawMsgs=Array.isArray(req.messages)?req.messages:[];const allowedRoles=new Set(["system","user","assistant","tool"]);const msgs=rawMsgs.map(m=>{const role=allowedRoles.has(String(m&&m.role||""))?String(m.role):"user";const content=norm(m&&Object.prototype.hasOwnProperty.call(m,"content")?m.content:"").trim();if(!content)return null;const out={role,content};if(role==="tool"&&m&&typeof m==="object"&&typeof m.tool_call_id==="string"&&m.tool_call_id){out.tool_call_id=m.tool_call_id;}if(role==="assistant"&&m&&typeof m==="object"&&Array.isArray(m.tool_calls)&&m.tool_calls.length>0){out.tool_calls=m.tool_calls;}return out;}).filter(Boolean);let total=0;const kept=[];for(let i=msgs.length-1;i>=0;i--){const msg=msgs[i];const cost=msg.content.length+msg.role.length+32;if(kept.length>0&&total+cost>maxChars) continue;kept.unshift(msg);total+=cost;}const firstSystem=msgs.find(m=>m.role==="system");if(firstSystem&&!kept.some(m=>m.role==="system")&&(total+firstSystem.content.length+32)<=maxChars){kept.unshift(firstSystem);total+=firstSystem.content.length+32;}if(kept.length===0){const fallback=(typeof req.prompt==="string"?req.prompt:norm(req.prompt)).trim();kept.push({role:"user",content:fallback.slice(-maxChars)||"Hello"});}process.stdout.write(JSON.stringify({model:"{{provider_model}}",messages:kept,stream:false}));}catch{process.stdout.write(JSON.stringify({model:"{{provider_model}}",messages:[{role:"user",content:"Hello"}],stream:false}));}});'
              )"
              printf "%s" "$PAYLOAD" | curl -fsS https://api.groq.com/openai/v1/chat/completions \
                -H "Authorization: Bearer $GROQ_API_KEY" \
                -H "Content-Type: application/json" \
                --data-binary @- | \
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
