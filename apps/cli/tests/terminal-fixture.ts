import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Give the pinned Host a local OpenAI-compatible test route in its temporary home. */
export async function terminalFixtureEnv(home: string, endpoint: string, key: string, imageInput = false): Promise<Record<string, string>> {
  const runtimeHome = join(home, 'ds-cli-host-0.2')
  await mkdir(runtimeHome, { recursive: true })
  await writeFile(join(runtimeHome, 'cordis.patch.yml'), JSON.stringify([
    {
      id: 'llm-pi-ai',
      config: {
        providers: {
          'ds-cli-fixture': {
            api: 'openai-completions',
            apiKeyEnv: 'DS_CLI_FIXTURE_KEY',
            baseURL: endpoint,
            models: [{ id: 'fixture-model', ...(imageInput ? { input: ['text', 'image'] } : {}) }],
          },
        },
      },
    },
    { id: 'agent-default-model', config: { provider: 'ds-cli-fixture', model: 'fixture-model' } },
    { id: 'session-title-llm', disabled: true },
  ]))
  return { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DS_CLI_FIXTURE_KEY: key }
}
