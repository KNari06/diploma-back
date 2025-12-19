import { supabase } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import {
  MessageFeedback,
  CreateFeedbackRequest,
  FeedbackStatistics,
  FeedbackAnalytics,
} from '@/types';

/**
 * Service for managing user feedback on AI chat messages
 * Used to improve AI response quality through RLHF and analytics
 */
export class FeedbackService {
  /**
   * Create feedback for a message
   */
  static async createFeedback(
    userId: string,
    sessionId: string,
    request: CreateFeedbackRequest
  ): Promise<MessageFeedback> {
    try {
      logger.info('[FEEDBACK] Creating feedback', {
        userId,
        sessionId,
        messageId: request.message_id,
        feedbackType: request.feedback_type,
      });

      // Check if message exists and belongs to user's session
      const { data: message, error: messageError } = await supabase
        .from('chat_messages')
        .select('id, session_id')
        .eq('id', request.message_id)
        .single();

      if (messageError || !message) {
        throw new Error('Message not found');
      }

      // Verify session ownership
      const { data: session, error: sessionError } = await supabase
        .from('chat_sessions')
        .select('id, user_id')
        .eq('id', message.session_id)
        .eq('user_id', userId)
        .single();

      if (sessionError || !session) {
        throw new Error('Unauthorized: Message does not belong to user');
      }

      // Check if feedback already exists (update instead of create)
      const { data: existingFeedback } = await supabase
        .from('message_feedback')
        .select('id')
        .eq('message_id', request.message_id)
        .eq('user_id', userId)
        .single();

      let result;

      if (existingFeedback) {
        // Update existing feedback
        const { data, error } = await supabase
          .from('message_feedback')
          .update({
            feedback_type: request.feedback_type,
            intent_type: request.intent_type,
            context: request.context || {},
          })
          .eq('id', existingFeedback.id)
          .select()
          .single();

        if (error) throw error;
        result = data;

        logger.info('[FEEDBACK] Updated existing feedback', {
          feedbackId: existingFeedback.id,
        });
      } else {
        // Create new feedback
        const { data, error } = await supabase
          .from('message_feedback')
          .insert({
            message_id: request.message_id,
            user_id: userId,
            session_id: message.session_id,
            feedback_type: request.feedback_type,
            intent_type: request.intent_type,
            context: request.context || {},
          })
          .select()
          .single();

        if (error) throw error;
        result = data;

        logger.info('[FEEDBACK] Created new feedback', { feedbackId: result.id });
      }

      return result as MessageFeedback;
    } catch (error) {
      logger.error('[FEEDBACK] Error creating feedback:', error);
      throw error;
    }
  }

  /**
   * Get feedback for a specific message
   */
  static async getFeedbackForMessage(
    messageId: string,
    userId: string
  ): Promise<MessageFeedback | null> {
    try {
      const { data, error } = await supabase
        .from('message_feedback')
        .select('*')
        .eq('message_id', messageId)
        .eq('user_id', userId)
        .single();

      if (error && error.code !== 'PGRST116') {
        // PGRST116 = no rows returned
        throw error;
      }

      return data as MessageFeedback | null;
    } catch (error) {
      logger.error('[FEEDBACK] Error getting feedback:', error);
      return null;
    }
  }

  /**
   * Get all feedback for a user's session
   */
  static async getFeedbackForSession(
    sessionId: string,
    userId: string
  ): Promise<MessageFeedback[]> {
    try {
      const { data, error } = await supabase
        .from('message_feedback')
        .select('*')
        .eq('session_id', sessionId)
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (error) throw error;

      return (data as MessageFeedback[]) || [];
    } catch (error) {
      logger.error('[FEEDBACK] Error getting session feedback:', error);
      return [];
    }
  }

  /**
   * Delete feedback
   */
  static async deleteFeedback(
    feedbackId: string,
    userId: string
  ): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('message_feedback')
        .delete()
        .eq('id', feedbackId)
        .eq('user_id', userId);

      if (error) throw error;

      logger.info('[FEEDBACK] Deleted feedback', { feedbackId });
      return true;
    } catch (error) {
      logger.error('[FEEDBACK] Error deleting feedback:', error);
      return false;
    }
  }

  /**
   * Get feedback analytics for a user
   */
  static async getUserFeedbackStats(
    userId: string,
    days: number = 30
  ): Promise<FeedbackStatistics> {
    try {
      const dateFrom = new Date();
      dateFrom.setDate(dateFrom.getDate() - days);

      // Get all feedback for user
      const { data: allFeedback, error } = await supabase
        .from('message_feedback')
        .select('*')
        .eq('user_id', userId)
        .gte('created_at', dateFrom.toISOString())
        .order('created_at', { ascending: false });

      if (error) throw error;

      const feedback = (allFeedback as MessageFeedback[]) || [];

      // Calculate statistics
      const total = feedback.length;
      const likes = feedback.filter((f) => f.feedback_type === 'like').length;
      const dislikes = feedback.filter((f) => f.feedback_type === 'dislike').length;
      const satisfactionRate = total > 0 ? (likes / total) * 100 : 0;

      // Group by intent type
      const byIntentMap = new Map<
        string,
        { likes: number; dislikes: number; total: number }
      >();

      feedback.forEach((f) => {
        const intent = f.intent_type || 'unknown';
        if (!byIntentMap.has(intent)) {
          byIntentMap.set(intent, { likes: 0, dislikes: 0, total: 0 });
        }
        const stats = byIntentMap.get(intent)!;
        stats.total++;
        if (f.feedback_type === 'like') stats.likes++;
        if (f.feedback_type === 'dislike') stats.dislikes++;
      });

      const byIntent = Array.from(byIntentMap.entries()).map(
        ([intent_type, stats]) => ({
          intent_type,
          likes: stats.likes,
          dislikes: stats.dislikes,
          total: stats.total,
          satisfaction_rate: (stats.likes / stats.total) * 100,
        })
      );

      return {
        total_feedback: total,
        likes,
        dislikes,
        satisfaction_rate: Math.round(satisfactionRate * 100) / 100,
        by_intent: byIntent,
        recent_feedback: feedback.slice(0, 10), // Last 10
      };
    } catch (error) {
      logger.error('[FEEDBACK] Error getting user stats:', error);
      throw error;
    }
  }

  /**
   * Get global feedback analytics (admin only)
   */
  static async getGlobalFeedbackStats(
    days: number = 30
  ): Promise<FeedbackStatistics> {
    try {
      const dateFrom = new Date();
      dateFrom.setDate(dateFrom.getDate() - days);

      // Get all feedback
      const { data: allFeedback, error } = await supabase
        .from('message_feedback')
        .select('*')
        .gte('created_at', dateFrom.toISOString())
        .order('created_at', { ascending: false });

      if (error) throw error;

      const feedback = (allFeedback as MessageFeedback[]) || [];

      // Calculate statistics
      const total = feedback.length;
      const likes = feedback.filter((f) => f.feedback_type === 'like').length;
      const dislikes = feedback.filter((f) => f.feedback_type === 'dislike').length;
      const satisfactionRate = total > 0 ? (likes / total) * 100 : 0;

      // Group by intent type
      const byIntentMap = new Map<
        string,
        { likes: number; dislikes: number; total: number }
      >();

      feedback.forEach((f) => {
        const intent = f.intent_type || 'unknown';
        if (!byIntentMap.has(intent)) {
          byIntentMap.set(intent, { likes: 0, dislikes: 0, total: 0 });
        }
        const stats = byIntentMap.get(intent)!;
        stats.total++;
        if (f.feedback_type === 'like') stats.likes++;
        if (f.feedback_type === 'dislike') stats.dislikes++;
      });

      const byIntent = Array.from(byIntentMap.entries()).map(
        ([intent_type, stats]) => ({
          intent_type,
          likes: stats.likes,
          dislikes: stats.dislikes,
          total: stats.total,
          satisfaction_rate: (stats.likes / stats.total) * 100,
        })
      );

      return {
        total_feedback: total,
        likes,
        dislikes,
        satisfaction_rate: Math.round(satisfactionRate * 100) / 100,
        by_intent: byIntent,
        recent_feedback: feedback.slice(0, 20),
      };
    } catch (error) {
      logger.error('[FEEDBACK] Error getting global stats:', error);
      throw error;
    }
  }

  /**
   * Get time-series analytics from view
   */
  static async getAnalyticsTimeSeries(
    userId?: string,
    days: number = 30
  ): Promise<FeedbackAnalytics[]> {
    try {
      const dateFrom = new Date();
      dateFrom.setDate(dateFrom.getDate() - days);

      const query = supabase
        .from('feedback_analytics')
        .select('*')
        .gte('date', dateFrom.toISOString().split('T')[0])
        .order('date', { ascending: false });

      // Note: The view doesn't have user_id filter
      // For user-specific analytics, use getUserFeedbackStats instead

      const { data, error } = await query;

      if (error) throw error;

      return (data as FeedbackAnalytics[]) || [];
    } catch (error) {
      logger.error('[FEEDBACK] Error getting analytics time series:', error);
      return [];
    }
  }

  /**
   * Get most liked/disliked messages for learning
   * Used for RLHF and prompt improvement
   */
  static async getTopFeedbackMessages(
    feedbackType: 'like' | 'dislike',
    intentType?: string,
    limit: number = 50
  ): Promise<
    Array<{
      feedback: MessageFeedback;
      message: any;
    }>
  > {
    try {
      let query = supabase
        .from('message_feedback')
        .select(
          `
          *,
          chat_messages!inner(*)
        `
        )
        .eq('feedback_type', feedbackType)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (intentType) {
        query = query.eq('intent_type', intentType);
      }

      const { data, error } = await query;

      if (error) throw error;

      return (
        data?.map((item: any) => ({
          feedback: item as MessageFeedback,
          message: item.chat_messages,
        })) || []
      );
    } catch (error) {
      logger.error('[FEEDBACK] Error getting top feedback messages:', error);
      return [];
    }
  }
}
