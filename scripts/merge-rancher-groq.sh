#!/usr/bin/env bash
set -euo pipefail

INPUT_PATH="kubernetes/rancher-install.yaml"
OUTPUT_PATH="kubernetes/rancher-install-groq.yaml"
GROQ_API_KEY="replace-with-groq-api-key"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --input)
      INPUT_PATH="$2"
      shift 2
      ;;
    --output)
      OUTPUT_PATH="$2"
      shift 2
      ;;
    --groq-api-key)
      GROQ_API_KEY="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 [--input path] [--output path] [--groq-api-key key]" >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "$INPUT_PATH" ]]; then
  echo "Input file not found: $INPUT_PATH" >&2
  exit 1
fi

TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

cat > "$TMP_FILE" <<EOF
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
              REQUEST_JSON="\$(cat)"
              PROMPT="\$(
                printf "%s" "\$REQUEST_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const req=JSON.parse(d);const msgs=Array.isArray(req.messages)?req.messages:[];const norm=v=>typeof v==="string"?v:JSON.stringify(v??"");const text=msgs.map(m=>{const role=String(m&&m.role?m.role:"user").toUpperCase();const content=norm(m&&Object.prototype.hasOwnProperty.call(m,"content")?m.content:"");return role+":\n"+content;}).join("\n\n");process.stdout.write((typeof req.prompt==="string"&&req.prompt.trim()?req.prompt:text).trim());}catch{process.stdout.write("");}});'
              )"
              curl -fsS https://api.groq.com/openai/v1/chat/completions \
                -H "Authorization: Bearer \$GROQ_API_KEY" \
                -H "Content-Type: application/json" \
                -d "\$(printf '{"model":"%s","messages":[{"role":"user","content":%s}],"stream":false}' "{{provider_model}}" "\$(printf "%s" "\$PROMPT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.stringify(String(d))));')")" | \
                node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const out={output_text:"",tool_calls:[],finish_reason:"stop"};try{const res=JSON.parse(d);const choice=Array.isArray(res.choices)&&res.choices[0]&&typeof res.choices[0]==="object"?res.choices[0]:{};const msg=choice.message&&typeof choice.message==="object"?choice.message:{};const content=typeof msg.content==="string"?msg.content.trim():"";const toolCalls=Array.isArray(msg.tool_calls)?msg.tool_calls.map((call,i)=>{if(!call||typeof call!=="object") return null;const fn=call.function&&typeof call.function==="object"?call.function:{};const name=typeof fn.name==="string"?fn.name.trim():"";if(!name) return null;const args=typeof fn.arguments==="string"?fn.arguments:JSON.stringify(fn.arguments??{});return {id:typeof call.id==="string"&&call.id?call.id:`call_${i+1}`,name,arguments:args};}).filter(Boolean):[];const finish=typeof choice.finish_reason==="string"&&choice.finish_reason?choice.finish_reason:(toolCalls.length>0?"tool_calls":"stop");out.output_text=content;out.tool_calls=toolCalls;out.finish_reason=finish;}catch(e){out.output_text=d.trim();}process.stdout.write(JSON.stringify(out));});'
          input: request_json_stdin
          output: json_contract
          timeoutMs: 120000
        auth:
          statusCommand:
            executable: sh
            args:
              - -lc
              - |
                test -n "\${GROQ_API_KEY:-}" || { echo '{"ok":false,"error":"GROQ_API_KEY not set"}'; exit 1; }
                curl -fsS https://api.groq.com/openai/v1/models \
                  -H "Authorization: Bearer \$GROQ_API_KEY" >/dev/null
                echo '{"ok":true}'
            timeoutMs: 15000
EOF

awk \
  -v groq_secret="  groqApiKey: \"$GROQ_API_KEY\"" \
  -v groq_provider_file="$TMP_FILE" \
  '
  BEGIN {
    inside_providers = 0
    provider_added = 0
    secret_added = 0
    env_added = 0
    saw_nanobanana_google = 0
  }
  {
    line = $0

    if (line ~ /^  providers.yaml: \|$/) {
      inside_providers = 1
    }

    print line

    if (!secret_added && line ~ /^  adminApiKey: /) {
      print groq_secret
      secret_added = 1
      next
    }

    if (line ~ /^            - name: NANOBANANA_GOOGLE_API_KEY$/) {
      saw_nanobanana_google = 1
      next
    }

    if (saw_nanobanana_google && !env_added && line ~ /^                  key: geminiApiKey$/) {
      print "            - name: GROQ_API_KEY"
      print "              valueFrom:"
      print "                secretKeyRef:"
      print "                  name: n8n-openai-cli-gateway-secrets"
      print "                  key: groqApiKey"
      env_added = 1
      saw_nanobanana_google = 0
      next
    }

    if (inside_providers && !provider_added && line == "---") {
      while ((getline provider_line < groq_provider_file) > 0) {
        print provider_line
      }
      close(groq_provider_file)
      print line
      provider_added = 1
      inside_providers = 0
      next
    }
  }
  END {
    if (!secret_added) {
      print "Failed to add groqApiKey secret entry." > "/dev/stderr"
      exit 1
    }
    if (!env_added) {
      print "Failed to add GROQ_API_KEY env entry." > "/dev/stderr"
      exit 1
    }
    if (!provider_added) {
      print "Failed to add Groq provider block to providers.yaml." > "/dev/stderr"
      exit 1
    }
  }
  ' "$INPUT_PATH" > "$OUTPUT_PATH"

echo "Wrote merged Groq Rancher manifest to $OUTPUT_PATH"
