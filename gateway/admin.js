#!/usr/bin/env node
/**
 * Admin CLI script to validate/reject access requests
 * Usage: bun admin.js approve|reject <email>
 */

import { MongoClient } from 'mongodb';
import 'dotenv/config';

async function main() {
  const [,, action, email] = process.argv;
  
  if (!action) {
    console.log('Usage: bun admin.js <approve|reject|list|users> [email]');
    console.log('');
    console.log('Commands:');
    console.log('  approve <email>  - Approve access request');
    console.log('  reject <email>   - Reject access request');
    console.log('  list             - List all pending requests');
    console.log('  users            - List all users');
    console.log('');
    process.exit(1);
  }
  
  if (!['approve', 'reject', 'list', 'users'].includes(action)) {
    console.error('Action must be "approve", "reject", "list", or "users"');
    process.exit(1);
  }
  
  // email required for approve/reject
  if (['approve', 'reject'].includes(action) && !email) {
    console.error(`Email required for "${action}"`);
    process.exit(1);
  }
  
  const client = new MongoClient(process.env.MONGODB_URI);
  
  try {
    await client.connect();
    const db = client.db('llm-gateway');
    const accessRequests = db.collection('access_requests');
    const validatedUsers = db.collection('validated_users');
    
    if (action === 'list') {
      const pendingRequests = await accessRequests
        .find({ status: 'pending' })
        .sort({ requestedAt: -1 })
        .toArray();
      
      console.log('\n📋 Pending Requests:\n');
      
      if (pendingRequests.length === 0) {
        console.log('  No pending requests.');
      } else {
        pendingRequests.forEach((req, i) => {
          console.log(`  ${i + 1}. ${req.email}`);
          console.log(`     Requested: ${new Date(req.requestedAt).toLocaleString()}`);
          console.log('');
        });
      }
      
      return;
    }
    
    if (action === 'users') {
      const users = await validatedUsers
        .find({})
        .sort({ validatedAt: -1 })
        .toArray();
      
      console.log('\n👥 All Users:\n');
      
      if (users.length === 0) {
        console.log('  No users yet.');
      } else {
        users.forEach((user, i) => {
          const roleBadge = user.role === 'admin' ? '👑' : user.role === 'user' ? '✅' : '⏳';
          console.log(`  ${i + 1}. ${user.email} ${roleBadge} (${user.role || 'guest'})`);
          console.log(`     Created: ${new Date(user.createdAt || user.validatedAt).toLocaleString()}`);
          if (user.validatedAt) {
            console.log(`     Approved: ${new Date(user.validatedAt).toLocaleString()}`);
          }
          console.log(`     Last Login: ${user.lastLogin ? new Date(user.lastLogin).toLocaleString() : 'Never'}`);
          console.log('');
        });
      }
      
      return;
    }
    
    // For approve/reject actions
    const normalizedEmail = email.toLowerCase().trim();
    
    // Update request
    const requestResult = await accessRequests.updateOne(
      { email: normalizedEmail },
      { 
        $set: { 
          status: action === 'approve' ? 'approved' : 'rejected',
          approvedAt: new Date()
        }
      }
    );
    
    if (requestResult.matchedCount === 0) {
      console.error(`❌ No access request found for: ${normalizedEmail}`);
      process.exit(1);
    }
    
    // Upgrade guest → user if approving
    if (action === 'approve') {
      const existingUser = await validatedUsers.findOne({ email: normalizedEmail });
      
      if (!existingUser) {
        // Create user if doesn't exist
        await validatedUsers.insertOne({
          email: normalizedEmail,
          role: 'user',
          validatedBy: 'admin',
          validatedAt: new Date(),
          createdAt: new Date()
        });
        console.log(`✅ Access approved for: ${normalizedEmail}`);
      } else {
        // Upgrade role from guest to user
        await validatedUsers.updateOne(
          { email: normalizedEmail },
          { 
            $set: { 
              role: 'user',
              validatedBy: 'admin',
              validatedAt: new Date()
            }
          }
        );
        console.log(`✅ Access approved for: ${normalizedEmail} (upgraded from ${existingUser.role || 'guest'} → user)`);
      }
      
      console.log('   User can now login to the dashboard');
      console.log('   Session will be valid for 1 year');
      console.log('   Refresh dashboard to see full access');
    } else {
      console.log(`❌ Access rejected for: ${normalizedEmail}`);
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();
