import { generateClarifyingQuestions } from '@/services/utils/question-generator.service';

/**
 * Generate questions for missing information
 */
export async function requestMissingInformation(
  userMessage: string,
  currentContext: {
    hasUrl?: boolean;
    hasScope?: boolean;
    hasCredentials?: boolean;
    intent?: string;
    userProjects?: Array<{ id: string; name: string; settings?: { main_url?: string } }>;
  }
): Promise<{
  needsMoreInfo: boolean;
  questions: any[];
  conversationId: string;
}> {
  return await generateClarifyingQuestions(userMessage, currentContext);
}
