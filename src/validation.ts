import { z } from "zod";
import { REASONING_EFFORT_VALUES } from "./types";

// Chat message validation
const chatRoleSchema = z.enum(["system", "user", "assistant", "tool"]);

const chatMessageSchema = z.object({
  role: chatRoleSchema,
  content: z.unknown().optional(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.unknown().optional(),
  tool_call: z.unknown().optional(),
  function_call: z.unknown().optional(),
}).passthrough();

// Tool definition validation - flexible schema to allow various tool formats
// The actual normalization happens in the route handlers
const toolDefinitionSchema = z.object({
  type: z.literal("function").optional(),
  function: z
    .object({
      name: z.string().optional(),
      description: z.string().optional(),
      parameters: z.unknown().optional(),
    })
    .passthrough()
    .optional(),
  // Allow other properties that the normalization logic handles
  name: z.string().optional(),
  description: z.string().optional(),
  parameters: z.unknown().optional(),
}).passthrough();

const reasoningEffortSchema = z.enum(REASONING_EFFORT_VALUES);

const reasoningConfigSchema = z.object({
  effort: reasoningEffortSchema.optional(),
}).passthrough();

// Chat completions request schema
export const chatCompletionsRequestSchema = z.object({
  model: z.string().min(1, "model is required"),
  messages: z.array(chatMessageSchema).min(1, "messages must include at least one item"),
  tools: z.array(toolDefinitionSchema).optional(),
  functions: z.array(z.unknown()).optional(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().int().optional(),
  top_p: z.number().optional(),
  presence_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
  user: z.string().optional(),
  reasoning_effort: reasoningEffortSchema.optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  reasoning: reasoningConfigSchema.optional(),
}).passthrough();

// Responses API input item schema - very permissive for n8n compatibility
// Accepts strings, objects, or null/undefined items
const responseInputItemSchema = z.union([
  z.string(),
  z.object({}).passthrough(), // Accept any object with passthrough
  z.null(),
  z.undefined(),
]);

// Responses API request schema
export const responsesRequestSchema = z.object({
  model: z.string().min(1, "model is required"),
  input: z.union([z.string(), responseInputItemSchema, z.array(responseInputItemSchema)]).optional(),
  instructions: z.string().optional(),
  tools: z.array(toolDefinitionSchema).optional(),
  functions: z.array(z.unknown()).optional(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().int().optional(),
  top_p: z.number().optional(),
  user: z.string().optional(),
  tool_choice: z.unknown().optional(),
  reasoning_effort: reasoningEffortSchema.optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  reasoning: reasoningConfigSchema.optional(),
}).passthrough();

// Image generations request schema
export const imageGenerationsRequestSchema = z.object({
  model: z.string().min(1, "model is required"),
  prompt: z.unknown(),
  n: z.number().int().min(1).max(10).optional(),
  size: z.string().optional(),
  quality: z.string().optional(),
  style: z.string().optional(),
  user: z.string().optional(),
});

// Audio speech (TTS) request schema
export const audioSpeechRequestSchema = z.object({
  model: z.string().min(1, "model is required"),
  input: z.string().min(1, "input is required"),
  voice: z.string().optional(),
  response_format: z.enum(["mp3", "opus", "aac", "flac", "wav", "pcm"]).optional(),
  speed: z.number().min(0.25).max(4.0).optional(),
  user: z.string().optional(),
});

// Audio transcriptions (STT) request schema
export const audioTranscriptionsRequestSchema = z.object({
  model: z.string().min(1, "model is required"),
  file: z.string().min(1, "file path is required"),
  language: z.string().optional(),
  prompt: z.string().optional(),
  response_format: z.enum(["json", "text", "srt", "verbose_json", "vtt"]).optional(),
  temperature: z.number().min(0).max(1).optional(),
  user: z.string().optional(),
});

// Audio translations request schema
export const audioTranslationsRequestSchema = z.object({
  model: z.string().min(1, "model is required"),
  file: z.string().min(1, "file path is required"),
  prompt: z.string().optional(),
  response_format: z.enum(["json", "text", "srt", "verbose_json", "vtt"]).optional(),
  temperature: z.number().min(0).max(1).optional(),
  user: z.string().optional(),
});

export type ChatCompletionsRequest = z.infer<typeof chatCompletionsRequestSchema>;
export type ResponsesRequest = z.infer<typeof responsesRequestSchema>;
export type ImageGenerationsRequest = z.infer<typeof imageGenerationsRequestSchema>;
export type AudioSpeechRequest = z.infer<typeof audioSpeechRequestSchema>;
export type AudioTranscriptionsRequest = z.infer<typeof audioTranscriptionsRequestSchema>;
export type AudioTranslationsRequest = z.infer<typeof audioTranslationsRequestSchema>;
