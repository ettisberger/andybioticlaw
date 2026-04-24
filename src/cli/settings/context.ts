import { readFileSync, writeFileSync } from 'node:fs';
import { readEnvFile, writeEnvFileUpdates } from '../../config/env-file.js';
import type { VoiceStateRepo } from '../../db/repositories/voice-state.js';
import type { BriefingManager } from '../briefings/manager.js';
import type { SettingsContext, Stdin } from './types.js';

export interface CreateContextInput {
  stdin: Stdin;
  stdout: NodeJS.WritableStream;
  configPath: string;
  envPath: string;
  voiceState: VoiceStateRepo;
  briefings: BriefingManager;
}

/**
 * Factory for the runtime-backed SettingsContext.
 *
 * Wraps disk reads (`readYaml`, `readEnv`) so components can call them
 * freely on every render without worrying about caching — the reads
 * are dirt-cheap on local fs, and caching would create staleness
 * bugs between the render of section A and section B.
 *
 * Tests substitute a fake context that points at a tmpdir instead of
 * the real config paths; everything else about the component logic
 * stays identical.
 */
export function createSettingsContext(input: CreateContextInput): SettingsContext {
  return {
    stdin: input.stdin,
    stdout: input.stdout,
    configPath: input.configPath,
    envPath: input.envPath,
    voiceState: input.voiceState,
    briefings: input.briefings,
    readYaml() {
      return readFileSync(input.configPath, 'utf8');
    },
    writeYaml(body) {
      writeFileSync(input.configPath, body);
    },
    readEnv() {
      return readEnvFile(input.envPath).values;
    },
    writeEnv(updates) {
      writeEnvFileUpdates(input.envPath, updates);
    },
  };
}
