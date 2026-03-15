/**
 * Announcement types and interfaces for "What's New" feature
 */

export type AnnouncementType = 'feature' | 'maintenance' | 'update' | 'breaking_change';
export type TargetAudience = 'all' | 'free' | 'pro' | 'enterprise';

export interface AnnouncementFeature {
  icon?: string;
  title: string;
  description: string;
}

export interface AnnouncementContent {
  features?: AnnouncementFeature[];
  images?: string[];
}

export interface Announcement {
  id: string;
  title: string;
  description: string;
  content: AnnouncementContent;
  type: AnnouncementType;
  targetAudience: TargetAudience;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  isActive: boolean;
  startsAt: string;
  expiresAt?: string | null;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAnnouncementData {
  title: string;
  description: string;
  content?: AnnouncementContent;
  type?: AnnouncementType;
  targetAudience?: TargetAudience;
  ctaLabel?: string;
  ctaUrl?: string;
  isActive?: boolean;
  startsAt?: string;
  expiresAt?: string | null;
}

export interface UpdateAnnouncementData {
  title?: string;
  description?: string;
  content?: AnnouncementContent;
  type?: AnnouncementType;
  targetAudience?: TargetAudience;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  isActive?: boolean;
  startsAt?: string;
  expiresAt?: string | null;
}

export interface AnnouncementWithStats extends Announcement {
  dismissedCount: number;
  totalEligibleUsers: number;
}
