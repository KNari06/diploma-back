import { supabaseAdmin } from '@/db/supabase';
import {
  Announcement,
  AnnouncementWithStats,
  CreateAnnouncementData,
  UpdateAnnouncementData,
} from '@/types/announcements.types';
import { logger } from '@/utils/core/logger';

const mapFromDB = (row: any): Announcement => ({
  id: row.id,
  title: row.title,
  description: row.description,
  content: row.content || {},
  type: row.type,
  targetAudience: row.target_audience,
  ctaLabel: row.cta_label,
  ctaUrl: row.cta_url,
  isActive: row.is_active,
  startsAt: row.starts_at,
  expiresAt: row.expires_at,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class AnnouncementService {
  /**
   * Get the latest active, non-dismissed announcement for a user.
   * Returns only the most recent one (LIMIT 1). If already dismissed — empty array.
   */
  static async getActiveForUser(userId: string): Promise<Announcement[]> {
    const now = new Date().toISOString();

    // Get the latest active announcement within date window
    const { data: latest, error: latestError } = await supabaseAdmin
      .from('announcements')
      .select('*')
      .eq('is_active', true)
      .lte('starts_at', now)
      .or(`expires_at.is.null,expires_at.gt.${now}`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestError) {
      logger.error('[ANNOUNCEMENTS] Error fetching latest announcement', { error: latestError.message, userId });
      throw latestError;
    }

    if (!latest) return [];

    // Check if this user already dismissed it
    const { data: dismissal } = await supabaseAdmin
      .from('announcement_dismissals')
      .select('id')
      .eq('announcement_id', latest.id)
      .eq('user_id', userId)
      .maybeSingle();

    if (dismissal) return [];

    return [mapFromDB(latest)];
  }

  /**
   * Dismiss an announcement for a user
   */
  static async dismiss(announcementId: string, userId: string): Promise<void> {
    const { error } = await supabaseAdmin
      .from('announcement_dismissals')
      .upsert(
        { announcement_id: announcementId, user_id: userId },
        { onConflict: 'announcement_id,user_id' }
      );

    if (error) {
      logger.error('[ANNOUNCEMENTS] Error dismissing', { error: error.message, announcementId, userId });
      throw error;
    }

    logger.info('[ANNOUNCEMENTS] Dismissed', { announcementId, userId });
  }

  // ── Admin CRUD ──

  static async listAll(): Promise<AnnouncementWithStats[]> {
    const { data, error } = await supabaseAdmin
      .from('announcements')
      .select('*, announcement_dismissals(count)')
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('[ANNOUNCEMENTS] Error listing all', { error: error.message });
      throw error;
    }

    const { count: totalUsers } = await supabaseAdmin
      .from('users')
      .select('id', { count: 'exact', head: true });

    return (data || []).map((row: any) => ({
      ...mapFromDB(row),
      dismissedCount: row.announcement_dismissals?.[0]?.count || 0,
      totalEligibleUsers: totalUsers || 0,
    }));
  }

  static async getById(id: string): Promise<AnnouncementWithStats | null> {
    const { data, error } = await supabaseAdmin
      .from('announcements')
      .select('*, announcement_dismissals(count)')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      logger.error('[ANNOUNCEMENTS] Error fetching by id', { error: error.message, id });
      throw error;
    }
    if (!data) return null;

    const { count: totalUsers } = await supabaseAdmin
      .from('users')
      .select('id', { count: 'exact', head: true });

    return {
      ...mapFromDB(data),
      dismissedCount: data.announcement_dismissals?.[0]?.count || 0,
      totalEligibleUsers: totalUsers || 0,
    };
  }

  static async create(data: CreateAnnouncementData, adminId: string): Promise<Announcement> {
    const { data: created, error } = await supabaseAdmin
      .from('announcements')
      .insert({
        title: data.title,
        description: data.description,
        content: data.content || {},
        type: data.type || 'feature',
        target_audience: data.targetAudience || 'all',
        cta_label: data.ctaLabel || null,
        cta_url: data.ctaUrl || null,
        is_active: data.isActive ?? true,
        starts_at: data.startsAt || new Date().toISOString(),
        expires_at: data.expiresAt || null,
        created_by: adminId,
      })
      .select()
      .single();

    if (error) {
      logger.error('[ANNOUNCEMENTS] Error creating', { error: error.message });
      throw error;
    }

    logger.info('[ANNOUNCEMENTS] Created', { id: created.id, title: data.title });
    return mapFromDB(created);
  }

  static async update(id: string, data: UpdateAnnouncementData): Promise<Announcement> {
    const updatePayload: any = {};
    if (data.title !== undefined) updatePayload.title = data.title;
    if (data.description !== undefined) updatePayload.description = data.description;
    if (data.content !== undefined) updatePayload.content = data.content;
    if (data.type !== undefined) updatePayload.type = data.type;
    if (data.targetAudience !== undefined) updatePayload.target_audience = data.targetAudience;
    if (data.ctaLabel !== undefined) updatePayload.cta_label = data.ctaLabel;
    if (data.ctaUrl !== undefined) updatePayload.cta_url = data.ctaUrl;
    if (data.isActive !== undefined) updatePayload.is_active = data.isActive;
    if (data.startsAt !== undefined) updatePayload.starts_at = data.startsAt;
    if (data.expiresAt !== undefined) updatePayload.expires_at = data.expiresAt;

    const { data: updated, error } = await supabaseAdmin
      .from('announcements')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      logger.error('[ANNOUNCEMENTS] Error updating', { error: error.message, id });
      throw error;
    }

    logger.info('[ANNOUNCEMENTS] Updated', { id });
    return mapFromDB(updated);
  }

  static async delete(id: string): Promise<void> {
    const { error } = await supabaseAdmin
      .from('announcements')
      .delete()
      .eq('id', id);

    if (error) {
      logger.error('[ANNOUNCEMENTS] Error deleting', { error: error.message, id });
      throw error;
    }

    logger.info('[ANNOUNCEMENTS] Deleted', { id });
  }
}
