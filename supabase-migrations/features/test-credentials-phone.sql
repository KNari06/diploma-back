-- Migration: Add phone_encrypted column to test_credentials table
-- Date: 2026-01-14
-- Purpose: Support phone number as a credential for login flows

-- Add phone_encrypted column if it doesn't exist
ALTER TABLE test_credentials
ADD COLUMN IF NOT EXISTS phone_encrypted TEXT;

-- Add comment for documentation
COMMENT ON COLUMN test_credentials.phone_encrypted IS 'Encrypted phone number for phone-based authentication, encrypted with AES-256';
