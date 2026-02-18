import { supabase, supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import {
  FeedbackInsights,
  FeedbackComparison,
  FeedbackStatistics,
  MessageFeedback,
} from '@/types';
import { FeedbackService } from './feedback.service';

/**
 * Advanced analytics service for feedback data
 * Provides insights, trends, and recommendations for improving AI responses
 */
export class FeedbackAnalyticsService {
  /**
   * Get comprehensive insights from feedback data
   */
  static async getInsights(
    userId?: string,
    days: number = 30
  ): Promise<FeedbackInsights> {
    try {
      logger.info('[FEEDBACK_ANALYTICS] Generating insights', { userId, days });

      // Get base statistics
      const stats = userId
        ? await FeedbackService.getUserFeedbackStats(userId, days)
        : await FeedbackService.getGlobalFeedbackStats(days);

      // Get time series for trend analysis
      const timeSeries = await this.getTimeSeriesData(userId, days);

      // Analyze trends
      const trend = this.analyzeTrend(timeSeries);

      // Get total AI messages count for feedback rate
      const totalMessages = await this.getTotalMessagesCount(userId, days);
      const feedbackRate = totalMessages > 0
        ? (stats.total_feedback / totalMessages) * 100
        : 0;

      // Identify problem areas
      const problemAreas = this.identifyProblemAreas(stats.by_intent);

      // Identify top performers
      const topPerformers = this.identifyTopPerformers(stats.by_intent);

      // Generate recommendations
      const recommendations = this.generateRecommendations(
        stats,
        problemAreas,
        trend
      );

      return {
        summary: {
          overall_satisfaction: stats.satisfaction_rate,
          total_responses: stats.total_feedback,
          feedback_rate: Math.round(feedbackRate * 100) / 100,
          trend,
        },
        problem_areas: problemAreas,
        top_performers: topPerformers,
        recommendations,
        time_series: timeSeries,
      };
    } catch (error) {
      logger.error('[FEEDBACK_ANALYTICS] Error generating insights:', error);
      throw error;
    }
  }

  /**
   * Compare feedback between two time periods
   */
  static async comparePerformance(
    userId?: string,
    currentDays: number = 7,
    previousDays: number = 7
  ): Promise<FeedbackComparison> {
    try {
      // Get current period stats
      const currentStats = userId
        ? await FeedbackService.getUserFeedbackStats(userId, currentDays)
        : await FeedbackService.getGlobalFeedbackStats(currentDays);

      // Get previous period stats
      const dateFrom = new Date();
      dateFrom.setDate(dateFrom.getDate() - currentDays - previousDays);
      const dateTo = new Date();
      dateTo.setDate(dateTo.getDate() - currentDays);

      const previousStats = await this.getStatsForPeriod(
        userId,
        dateFrom,
        dateTo
      );

      // Calculate changes
      const satisfactionChange =
        currentStats.satisfaction_rate - previousStats.satisfaction_rate;
      const likesChange = currentStats.likes - previousStats.likes;
      const dislikesChange = currentStats.dislikes - previousStats.dislikes;
      const totalChange = currentStats.total_feedback - previousStats.total_feedback;

      // Find improved and declined intents
      const improvedIntents: string[] = [];
      const declinedIntents: string[] = [];

      currentStats.by_intent.forEach((current: { intent_type: string; likes: number; dislikes: number; satisfaction_rate: number; total: number }) => {
        const previous = previousStats.by_intent.find(
          (p) => p.intent_type === current.intent_type
        );
        if (previous) {
          const change = current.satisfaction_rate - previous.satisfaction_rate;
          if (change > 5) improvedIntents.push(current.intent_type);
          if (change < -5) declinedIntents.push(current.intent_type);
        }
      });

      return {
        current_period: currentStats,
        previous_period: previousStats,
        changes: {
          satisfaction_rate_change: Math.round(satisfactionChange * 100) / 100,
          likes_change: likesChange,
          dislikes_change: dislikesChange,
          total_feedback_change: totalChange,
        },
        improved_intents: improvedIntents,
        declined_intents: declinedIntents,
      };
    } catch (error) {
      logger.error('[FEEDBACK_ANALYTICS] Error comparing performance:', error);
      throw error;
    }
  }

  /**
   * Get time series data for charts
   */
  private static async getTimeSeriesData(
    userId?: string,
    days: number = 30
  ): Promise<Array<{ date: string; likes: number; dislikes: number; satisfaction_rate: number }>> {
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - days);

    let query = supabase
      .from('message_feedback')
      .select('feedback_type, created_at')
      .gte('created_at', dateFrom.toISOString())
      .order('created_at', { ascending: true });

    if (userId) {
      query = query.eq('user_id', userId);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Group by date
    const byDate = new Map<string, { likes: number; dislikes: number }>();

    (data as MessageFeedback[]).forEach((item) => {
      const date = item.created_at.split('T')[0]; // YYYY-MM-DD
      if (!byDate.has(date)) {
        byDate.set(date, { likes: 0, dislikes: 0 });
      }
      const stats = byDate.get(date)!;
      if (item.feedback_type === 'like') stats.likes++;
      if (item.feedback_type === 'dislike') stats.dislikes++;
    });

    return Array.from(byDate.entries())
      .map(([date, stats]) => ({
        date,
        likes: stats.likes,
        dislikes: stats.dislikes,
        satisfaction_rate:
          stats.likes + stats.dislikes > 0
            ? (stats.likes / (stats.likes + stats.dislikes)) * 100
            : 0,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Analyze trend from time series
   */
  private static analyzeTrend(
    timeSeries: Array<{ satisfaction_rate: number }>
  ): 'improving' | 'declining' | 'stable' {
    if (timeSeries.length < 3) return 'stable';

    const recentData = timeSeries.slice(-7); // Last 7 data points
    const olderData = timeSeries.slice(0, Math.min(7, timeSeries.length - 7));

    if (recentData.length === 0 || olderData.length === 0) return 'stable';

    const recentAvg =
      recentData.reduce((sum, d) => sum + d.satisfaction_rate, 0) /
      recentData.length;
    const olderAvg =
      olderData.reduce((sum, d) => sum + d.satisfaction_rate, 0) /
      olderData.length;

    const diff = recentAvg - olderAvg;

    if (diff > 5) return 'improving';
    if (diff < -5) return 'declining';
    return 'stable';
  }

  /**
   * Get total count of AI messages
   */
  private static async getTotalMessagesCount(
    userId?: string,
    days: number = 30
  ): Promise<number> {
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - days);

    let query = supabase
      .from('chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'ai')
      .gte('created_at', dateFrom.toISOString());

    if (userId) {
      // Get sessions from workspaces the user is a member of
      const { data: memberships } = await supabaseAdmin
        .from('workspace_members')
        .select('workspace_id')
        .eq('user_id', userId)
        .eq('status', 'active');

      if (memberships && memberships.length > 0) {
        const workspaceIds = memberships.map((m) => m.workspace_id);
        const { data: sessions } = await supabaseAdmin
          .from('chat_sessions')
          .select('id')
          .in('workspace_id', workspaceIds);

        if (sessions) {
          const sessionIds = sessions.map((s) => s.id);
          query = query.in('session_id', sessionIds);
        }
      }
    }

    const { count } = await query;
    return count || 0;
  }

  /**
   * Identify problem areas from intent statistics
   */
  private static identifyProblemAreas(
    byIntent: Array<{
      intent_type: string;
      likes: number;
      dislikes: number;
      satisfaction_rate: number;
      total: number;
    }>
  ): Array<{
    intent_type: string;
    issue: string;
    severity: 'high' | 'medium' | 'low';
    affected_messages: number;
    satisfaction_rate: number;
  }> {
    return byIntent
      .filter((intent) => intent.satisfaction_rate < 70 && intent.total >= 3)
      .map((intent) => {
        let severity: 'high' | 'medium' | 'low' = 'low';
        let issue = 'Low satisfaction rate';

        if (intent.satisfaction_rate < 50) {
          severity = 'high';
          issue = 'Critical: Majority of users dissatisfied';
        } else if (intent.satisfaction_rate < 60) {
          severity = 'medium';
          issue = 'Many users reporting issues';
        }

        return {
          intent_type: intent.intent_type,
          issue,
          severity,
          affected_messages: intent.dislikes,
          satisfaction_rate: Math.round(intent.satisfaction_rate * 100) / 100,
        };
      })
      .sort((a, b) => {
        // Sort by severity and then by affected messages
        const severityOrder = { high: 3, medium: 2, low: 1 };
        if (severityOrder[a.severity] !== severityOrder[b.severity]) {
          return severityOrder[b.severity] - severityOrder[a.severity];
        }
        return b.affected_messages - a.affected_messages;
      });
  }

  /**
   * Identify top performing intents
   */
  private static identifyTopPerformers(
    byIntent: Array<{
      intent_type: string;
      satisfaction_rate: number;
      total: number;
    }>
  ): Array<{
    intent_type: string;
    satisfaction_rate: number;
    total_feedback: number;
    why_successful: string;
  }> {
    return byIntent
      .filter((intent) => intent.satisfaction_rate >= 85 && intent.total >= 3)
      .map((intent) => ({
        intent_type: intent.intent_type,
        satisfaction_rate: Math.round(intent.satisfaction_rate * 100) / 100,
        total_feedback: intent.total,
        why_successful: this.getSuccessReason(intent.intent_type, intent.satisfaction_rate),
      }))
      .sort((a, b) => b.satisfaction_rate - a.satisfaction_rate)
      .slice(0, 5);
  }

  /**
   * Generate actionable recommendations
   */
  private static generateRecommendations(
    stats: FeedbackStatistics,
    problemAreas: Array<{ intent_type: string; severity: string }>,
    trend: 'improving' | 'declining' | 'stable'
  ): Array<{
    priority: 'high' | 'medium' | 'low';
    area: string;
    action: string;
    expected_improvement: string;
  }> {
    const recommendations: Array<{
      priority: 'high' | 'medium' | 'low';
      area: string;
      action: string;
      expected_improvement: string;
    }> = [];

    // Overall satisfaction recommendations
    if (stats.satisfaction_rate < 70) {
      recommendations.push({
        priority: 'high',
        area: 'Overall AI Quality',
        action: 'Review and update system prompts. Analyze disliked messages for common patterns.',
        expected_improvement: '+15-20% satisfaction rate',
      });
    }

    // Trend-based recommendations
    if (trend === 'declining') {
      recommendations.push({
        priority: 'high',
        area: 'Performance Trend',
        action: 'Immediate review needed. Recent changes may have negatively impacted quality.',
        expected_improvement: 'Stop decline, restore to previous levels',
      });
    }

    // Problem area recommendations
    problemAreas.forEach((problem) => {
      if (problem.severity === 'high') {
        recommendations.push({
          priority: 'high',
          area: `${problem.intent_type} responses`,
          action: this.getRecommendationForIntent(problem.intent_type),
          expected_improvement: '+20-30% satisfaction for this intent',
        });
      }
    });

    // Low feedback rate
    if (stats.total_feedback < 10) {
      recommendations.push({
        priority: 'medium',
        area: 'Feedback Collection',
        action: 'Make feedback buttons more visible. Consider adding prompts asking for feedback.',
        expected_improvement: 'More data for better insights',
      });
    }

    // If no high priority issues, add improvement suggestions
    if (recommendations.filter((r) => r.priority === 'high').length === 0) {
      recommendations.push({
        priority: 'low',
        area: 'Continuous Improvement',
        action: 'Analyze top-liked messages to identify best practices. Apply learnings to other intents.',
        expected_improvement: '+5-10% overall satisfaction',
      });
    }

    return recommendations;
  }

  /**
   * Get success reason for high-performing intent
   */
  private static getSuccessReason(intentType: string, rate: number): string {
    if (rate >= 95) {
      return `Exceptional: ${intentType} responses are highly accurate and helpful`;
    }
    if (rate >= 90) {
      return `Excellent: Users consistently satisfied with ${intentType} responses`;
    }
    return `Strong performance: ${intentType} responses meet user expectations`;
  }

  /**
   * Get specific recommendation for intent type
   */
  private static getRecommendationForIntent(intentType: string): string {
    const recommendations: Record<string, string> = {
      api_test: 'Improve response format. Add more context about test results. Show request/response details clearly.',
      general_chat: 'Make responses more concise. Focus on answering the specific question asked.',
      ui_test: 'Provide clearer test plans before execution. Explain what will be tested.',
      platform_test: 'Add more detailed explanations of test steps and expected outcomes.',
    };

    return recommendations[intentType] || 'Analyze disliked messages to identify specific issues.';
  }

  /**
   * Get statistics for a specific date range
   */
  private static async getStatsForPeriod(
    userId: string | undefined,
    dateFrom: Date,
    dateTo: Date
  ): Promise<FeedbackStatistics> {
    let query = supabase
      .from('message_feedback')
      .select('*')
      .gte('created_at', dateFrom.toISOString())
      .lte('created_at', dateTo.toISOString());

    if (userId) {
      query = query.eq('user_id', userId);
    }

    const { data, error } = await query;
    if (error) throw error;

    const feedback = (data as MessageFeedback[]) || [];

    const total = feedback.length;
    const likes = feedback.filter((f) => f.feedback_type === 'like').length;
    const dislikes = feedback.filter((f) => f.feedback_type === 'dislike').length;
    const satisfactionRate = total > 0 ? (likes / total) * 100 : 0;

    // Group by intent
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
      recent_feedback: [],
    };
  }
}
