import { logger } from '@/utils/logger';
import { getChatCompletionWithMessages } from '@/services/ai/openai.service';

/**
 * Question types for user clarification
 */
export interface ClarifyingQuestion {
  id: string;
  question: string;
  required: boolean;
  type: 'url' | 'text' | 'credentials' | 'scope' | 'boolean';
  options?: string[];
  placeholder?: string;
  validation?: {
    pattern?: string;
    minLength?: number;
    maxLength?: number;
  };
}

/**
 * Base questions template (English for US market)
 */
const BASE_QUESTIONS: ClarifyingQuestion[] = [
  {
    id: 'url',
    question: 'What is the URL of your platform?',
    required: true,
    type: 'url',
    placeholder: 'https://example.com/register',
    validation: {
      pattern: '^https?://.+',
    },
  },
  {
    id: 'scope',
    question: 'What exactly should I test?',
    required: true,
    type: 'scope',
    options: [
      'Entire platform (comprehensive exploration)',
      'Specific page (e.g., registration page)',
      'Specific element (button, form, input)',
      'User flow (e.g., login → dashboard → action)',
      'Form functionality',
      'Authentication process',
      'Navigation/menu',
    ],
    placeholder: 'Example: registration form, checkout process, login flow',
  },
  {
    id: 'needs_auth',
    question: 'Does the page require authentication?',
    required: false,
    type: 'boolean',
  },
  {
    id: 'credentials',
    question: 'Please provide test credentials (any format)',
    required: false,
    type: 'credentials',
    placeholder: 'email@example.com / password123  or  {"email": "test@test.com", "password": "pass"}',
  },
];

/**
 * Generate clarifying questions using AI + base template
 */
export async function generateClarifyingQuestions(
  userMessage: string,
  currentContext: {
    hasUrl?: boolean;
    hasCredentials?: boolean;
    hasScope?: boolean;
    intent?: string;
  }
): Promise<{
  needsMoreInfo: boolean;
  questions: ClarifyingQuestion[];
  conversationId: string;
}> {
  try {
    logger.info('Generating clarifying questions', {
      userMessage: userMessage.substring(0, 50),
      context: currentContext,
    });

    // Start with base questions
    const questions: ClarifyingQuestion[] = [];

    // Always need URL if not provided
    if (!currentContext.hasUrl) {
      questions.push(BASE_QUESTIONS[0]); // url
    }

    // Always need scope if not clear
    if (!currentContext.hasScope) {
      questions.push(BASE_QUESTIONS[1]); // scope
    }

    // Ask about auth dynamically
    const needsAuthQuestion = await shouldAskAboutAuth(userMessage);
    if (needsAuthQuestion) {
      questions.push(BASE_QUESTIONS[2]); // needs_auth
    }

    // Generate additional dynamic questions using AI
    // IMPORTANT: Pass already asked questions to avoid duplicates
    const dynamicQuestions = await generateDynamicQuestions(userMessage, currentContext, questions);
    questions.push(...dynamicQuestions);

    const conversationId = generateConversationId();

    logger.info('Generated clarifying questions', {
      questionCount: questions.length,
      conversationId,
    });

    return {
      needsMoreInfo: questions.length > 0,
      questions,
      conversationId,
    };
  } catch (error) {
    logger.error('Failed to generate clarifying questions', error);

    // Fallback to base questions
    return {
      needsMoreInfo: true,
      questions: [BASE_QUESTIONS[0], BASE_QUESTIONS[1]],
      conversationId: generateConversationId(),
    };
  }
}

/**
 * Determine if we should ask about authentication
 */
async function shouldAskAboutAuth(
  userMessage: string
): Promise<boolean> {
  // Keywords that suggest auth is needed
  const authKeywords = [
    'dashboard',
    'profile',
    'account',
    'settings',
    'admin',
    'personal',
    'my',
    'authenticated',
    'logged in',
    'после входа',
    'после логина',
  ];

  const messageLC = userMessage.toLowerCase();
  return authKeywords.some(keyword => messageLC.includes(keyword));
}

/**
 * Generate dynamic questions using AI based on user intent
 */
async function generateDynamicQuestions(
  userMessage: string,
  context: any,
  alreadyAskedQuestions: ClarifyingQuestion[]
): Promise<ClarifyingQuestion[]> {
  try {
    const alreadyAskedList = alreadyAskedQuestions.map(q => `- ${q.question}`).join('\n');

    const prompt = `You are a QA assistant. A user wants to test their product but hasn't provided all necessary information.

User request: "${userMessage}"
Current context: ${JSON.stringify(context)}

IMPORTANT: These questions are ALREADY being asked (DO NOT duplicate):
${alreadyAskedList || '(none yet)'}

Generate 0-2 ADDITIONAL clarifying questions that would help create better tests.
ONLY ask questions that are NOT already covered above.

Examples of good ADDITIONAL questions:
- "What should happen after successful registration?" (for registration tests)
- "Are there any specific validation rules we should test?" (for form tests)
- "Which browser should we prioritize?" (if multi-browser testing)

Return ONLY a JSON array of questions in this format:
[
  {
    "id": "expected_outcome",
    "question": "What should happen after successful action?",
    "required": false,
    "type": "text",
    "placeholder": "e.g., redirect to dashboard"
  }
]

If no additional questions needed, return empty array: []`;

    const response = await getChatCompletionWithMessages([
      { role: 'system', content: 'You are a helpful QA assistant that generates clarifying questions.' },
      { role: 'user', content: prompt },
    ], {
      temperature: 0.3,
      response_format: { type: 'json_object' },
    });

    const parsed = JSON.parse(response.content);
    const questions = Array.isArray(parsed) ? parsed : parsed.questions || [];

    logger.info('Generated dynamic questions', {
      count: questions.length,
    });

    return questions.slice(0, 2); // Max 2 additional questions
  } catch (error) {
    logger.error('Failed to generate dynamic questions', error);
    return [];
  }
}

/**
 * Validate user answers
 */
export function validateAnswers(
  questions: ClarifyingQuestion[],
  answers: Record<string, any>
): {
  valid: boolean;
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};

  for (const question of questions) {
    const answer = answers[question.id];

    // Check required
    if (question.required && !answer) {
      errors[question.id] = 'This field is required';
      continue;
    }

    // Skip validation if not answered and not required
    if (!answer) continue;

    // Type-specific validation
    switch (question.type) {
      case 'url':
        if (!/^https?:\/\/.+/.test(answer)) {
          errors[question.id] = 'Please enter a valid URL starting with http:// or https://';
        }
        break;

      case 'credentials':
        try {
          const creds = typeof answer === 'string' ? JSON.parse(answer) : answer;
          if (!creds.email && !creds.username) {
            errors[question.id] = 'Credentials must include email or username';
          }
          if (!creds.password) {
            errors[question.id] = 'Credentials must include password';
          }
        } catch {
          errors[question.id] = 'Invalid credentials format. Expected JSON: {"email": "...", "password": "..."}';
        }
        break;

      case 'text':
        if (question.validation?.minLength && answer.length < question.validation.minLength) {
          errors[question.id] = `Minimum length: ${question.validation.minLength}`;
        }
        if (question.validation?.maxLength && answer.length > question.validation.maxLength) {
          errors[question.id] = `Maximum length: ${question.validation.maxLength}`;
        }
        break;
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

/**
 * Generate unique conversation ID
 */
function generateConversationId(): string {
  return `conv_${Date.now()}_${Math.random().toString(36).substring(7)}`;
}

/**
 * Parse user answers into structured format
 */
export function parseAnswers(
  answers: Record<string, any>
): {
  url?: string;
  scope?: string;
  needsAuth?: boolean;
  credentials?: {
    email?: string;
    username?: string;
    password: string;
  };
  additionalInfo?: Record<string, any>;
} {
  const parsed: any = {};

  if (answers.url) {
    parsed.url = answers.url;
  }

  if (answers.scope) {
    parsed.scope = answers.scope;
  }

  if (answers.needs_auth !== undefined) {
    parsed.needsAuth = answers.needs_auth === true || answers.needs_auth === 'true';
  }

  if (answers.credentials) {
    try {
      parsed.credentials = typeof answers.credentials === 'string'
        ? JSON.parse(answers.credentials)
        : answers.credentials;
    } catch {
      logger.warn('Failed to parse credentials');
    }
  }

  // Collect any additional answers
  const knownFields = ['url', 'scope', 'needs_auth', 'credentials'];
  const additionalInfo: Record<string, any> = {};

  for (const [key, value] of Object.entries(answers)) {
    if (!knownFields.includes(key)) {
      additionalInfo[key] = value;
    }
  }

  if (Object.keys(additionalInfo).length > 0) {
    parsed.additionalInfo = additionalInfo;
  }

  return parsed;
}
