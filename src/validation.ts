import { z } from "zod";

// Chat message validation
const chatRoleSchema = z.enum(["system", "user", "assistant", "tool"]);

const chatMessageSchema = z.object({
  role: chatRoleSchema,
  content: z.unknown(),
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
    .optional(),
  // Allow other properties that the normalization logic handles
  name: z.string().optional(),
  description: z.string().optional(),
  parameters: z.unknown().optional(),
});

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
});

// Responses API input item schema - flexible for n8n compatibility
const responseInputItemSchema = z.union([
  z.string(),
  z.object({
    role: chatRoleSchema.optional(),
    type: z.enum(["input_text", "function_call_output", "message", "tool_result"]).optional(),
    text: z.string().optional(),
    content: z.unknown().optional(),
    call_id: z.string().optional(),
    id: z.string().optional(),
    output: z.unknown().optional(),
    name: z.string().optional(),
    arguments: z.unknown().optional(),
    tool_call_id: z.string().optional(),
    // Allow additional properties for flexibility
  }).passthrough(),
]);

// Responses API request schema
export const responsesRequestSchema = z.object({
  model: z.string().min(1, "model is required"),
  input: z.union([z.string(), z.array(responseInputItemSchema)]).optional(),
  instructions: z.string().optional(),
  tools: z.array(toolDefinitionSchema).optional(),
  functions: z.array(z.unknown()).optional(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().int().optional(),
  top_p: z.number().optional(),
  user: z.string().optional(),
  tool_choice: z.unknown().optional(),
});

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

export type ChatCompletionsRequest = z.infer<typeof chatCompletionsRequestSchema>;
export type ResponsesRequest = z.infer<typeof responsesRequestSchema>;
export type ImageGenerationsRequest = z.infer<typeof imageGenerationsRequestSchema>;
