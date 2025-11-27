/**
 * Types for AI Extract Service
 */

export interface JSONSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean';
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
  description?: string;
}

export interface AIExtractExample {
  input: string;
  output: any;
}

export interface AIExtractRequest {
  selector: string;
  schema: JSONSchema;
  mode?: 'html' | 'text' | 'auto';
  examples?: AIExtractExample[];
  instructions?: string;
}

export interface AIExtractResponse {
  success: boolean;
  data?: any;
  error?: string;
  confidence?: number;
  metadata: {
    tokensUsed: number;
    duration: number; // milliseconds
    model: string;
    mode: 'html' | 'text' | 'auto';
    validationErrors?: string[]; // Detailed validation errors from AI
  };
}

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
  confidence?: number;
}

export interface SchemaGenerationResult {
  schema: JSONSchema;
  instructions: string;
}

export interface AdaptivePromptResult {
  prompt: string;
  schemaType: string;
}
