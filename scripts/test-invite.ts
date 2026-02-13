/**
 * Test script for workspace invite functionality
 * Usage: npx tsx scripts/test-invite.ts <workspace-id> <email>
 */

import { WorkspaceMembersService } from '../src/services/core/workspace-members.service';
import { supabaseAdmin } from '../src/db/supabase';
import { logger } from '../src/utils/core/logger';

async function testInvite() {
  const workspaceId = process.argv[2];
  const email = process.argv[3];

  if (!workspaceId || !email) {
    console.error('Usage: npx tsx scripts/test-invite.ts <workspace-id> <email>');
    process.exit(1);
  }

  console.log('\n🧪 Testing Workspace Invite Functionality\n');
  console.log(`Workspace ID: ${workspaceId}`);
  console.log(`Email: ${email}`);
  console.log(`Frontend URL: ${process.env.FRONTEND_URL}`);
  console.log('\n---\n');

  try {
    // Get workspace owner
    const { data: workspace, error: workspaceError } = await supabaseAdmin
      .from('workspaces')
      .select('*, workspace_members!inner(*)')
      .eq('id', workspaceId)
      .eq('workspace_members.role', 'owner')
      .eq('workspace_members.status', 'active')
      .single();

    if (workspaceError || !workspace) {
      console.error('❌ Workspace not found or no owner:', workspaceError?.message);
      process.exit(1);
    }

    const ownerId = workspace.workspace_members[0]?.user_id;
    if (!ownerId) {
      console.error('❌ No owner found for workspace');
      process.exit(1);
    }

    console.log(`✅ Found workspace owner: ${ownerId}\n`);

    // Create invite
    console.log('📧 Creating invite...\n');
    const result = await WorkspaceMembersService.createInvite(
      workspaceId,
      email,
      'full_access',
      ownerId,
      { ipAddress: '127.0.0.1', userAgent: 'test-script' }
    );

    if (result.success) {
      console.log('✅ Invite created successfully!');
      console.log('\nInvite Details:');
      console.log(`  - ID: ${result.invite?.id}`);
      console.log(`  - Email: ${result.invite?.email}`);
      console.log(`  - Role: ${result.invite?.role}`);
      console.log(`  - Status: ${result.invite?.status}`);
      console.log(`  - Expires: ${result.invite?.expires_at}`);
      console.log(`  - Supabase User ID: ${result.invite?.supabase_invite_user_id || 'N/A'}`);
      console.log('\n✉️  Check the email inbox for the invite!');
    } else {
      console.error(`❌ Failed to create invite: ${result.error}`);
      process.exit(1);
    }

    // List all invites for workspace
    console.log('\n---\n');
    console.log('📋 All invites for this workspace:\n');
    const invites = await WorkspaceMembersService.getInvites(workspaceId);

    if (invites.length === 0) {
      console.log('  No invites found');
    } else {
      invites.forEach((inv, idx) => {
        console.log(`  ${idx + 1}. ${inv.email} - ${inv.status} (${inv.role})`);
      });
    }

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  }
}

testInvite();
