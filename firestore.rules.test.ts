import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const RULES_PATH = path.resolve(process.cwd(), 'firestore.rules');
const BLUEPRINT_PATH = path.resolve(process.cwd(), 'firebase-blueprint.json');

describe('Firestore Security Rules — Dirty Dozen & Eight Pillars Verification', () => {
  it('enforces default-deny catch-all, verified admin email guard, strict schema helpers, and zero blanket reads', () => {
    const rules = fs.readFileSync(RULES_PATH, 'utf8');
    const blueprint = JSON.parse(fs.readFileSync(BLUEPRINT_PATH, 'utf8')) as {
      entities: Record<string, unknown>;
      firestore: Record<string, unknown>;
    };

    // Rules version 2 + default deny catch-all
    expect(rules).toContain("rules_version = '2';");
    expect(rules).toMatch(/match\s+\/\{document=\*\*\}\s*\{\s*allow read, write: if false;\s*\}/);

    // Every blueprint collection has an explicit match block
    for (const collectionPath of Object.keys(blueprint.firestore)) {
      expect(rules).toContain(`match ${collectionPath}`);
    }

    // Dirty Dozen #1, #2, #3: Verified admin check requires email_verified == true
    expect(rules).toContain('request.auth.token.email_verified == true');
    expect(rules).toContain("request.auth.token.email == 'zenitech007@gmail.com'");

    // Dirty Dozen #4, #5: Strict keys + URL regex guard on AppRuntimeConfig
    expect(rules).toContain('isValidAppConfig(');
    expect(rules).toContain('affectedKeys().hasOnly(');
    expect(rules).not.toContain('youtubeApiKey');

    // Dirty Dozen #6: /admins cannot be written by any client
    expect(rules).toMatch(/match \/admins\/\{adminId\}[\s\S]*allow list, create, update, delete: if false;/);

    // Dirty Dozen #7, #8, #9, #10, #11, #12: Path ID validation, owner isolation, immutability, temporal integrity
    expect(rules).toContain('isValidId(userId)');
    expect(rules).toContain('isValidId(playlistId)');
    expect(rules).toContain('resource.data.ownerId == request.auth.uid');
    expect(rules).toContain('incoming().ownerId == existing().ownerId');
    expect(rules).toContain('incoming().createdAt == existing().createdAt');
    expect(rules).toContain('incoming().createdAt == request.time');
    expect(rules).toContain('data.updatedAt == request.time');
    expect(rules).toContain('isValidSavedPlaylist(');
  });
});
