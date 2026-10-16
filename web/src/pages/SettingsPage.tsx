/**
 * Settings.
 *
 * Writes are explicit rather than on-change. These are application preferences
 * rather than form fields, and a toggle that PUTs on every click makes it
 * impossible to change a theme and a provider in one pass without two round
 * trips -- and gives no way to notice that a save failed.
 */

import { Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { PageHeading, SectionHeading, Spinner } from '@/components/common/StateBlocks';
import {
  useProviders,
  useSaveSettings,
  useSettings,
} from '@/hooks/useCatalog';
import { api } from '@/lib/api';
import type { ProviderKind, Settings } from '@/types';
import { notifyError, useUiStore } from '@/store/ui';

export function SettingsPage() {
  const current = useSettings();
  const providers = useProviders();
  const save = useSaveSettings();

  /**
   * The form's copy.
   *
   * Seeded from the server/local storage and then owned by this component.
   */
  const [draft, setDraft] = useState<Settings | null>(null);

  useEffect(() => {
    if (current.data) {
      const localProvider = localStorage.getItem('novaflix_active_provider') as ProviderKind | null;
      if (localProvider && localProvider !== current.data.active_provider) {
        setDraft({ ...current.data, active_provider: localProvider });
      } else {
        setDraft(current.data);
      }
    }
  }, [current.data]);

  if (current.isPending || !draft) return null;

  const dirty = JSON.stringify(draft) !== JSON.stringify(current.data);

  const patch = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setDraft({ ...draft, [key]: value });
  };

  const onSave = () => {
    if (!draft) return;
    if (draft.active_provider) {
      localStorage.setItem('novaflix_active_provider', draft.active_provider);
    }
    save.mutate(draft, {
      onSuccess: (saved) => {
        setDraft(saved);
        useUiStore.getState().notify('success', 'Settings saved');
      },
      onError: notifyError,
    });
  };

  return (
    <div className="mx-auto max-w-[1600px] px-4 pt-4 sm:px-6 lg:px-8">
      <PageHeading
        title="Settings"
        action={
          <div className="flex items-center gap-3">
            {dirty && <span className="text-[12.5px] text-fg-subtle">Unsaved changes</span>}
            <button
              type="button"
              onClick={onSave}
              disabled={!dirty || save.isPending}
              className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-[13px] font-semibold text-accent-contrast transition hover:bg-accent-hover disabled:pointer-events-none disabled:opacity-40"
            >
              {save.isPending && <Spinner />}
              Save
            </button>
          </div>
        }
      />

      <div className="grid gap-10 lg:grid-cols-2">
        <section>
          <SectionHeading
            id="heading-content"
            title="Content"
            subtitle="Turn a source off to remove it from search and browsing entirely."
          />

          <div className="space-y-1.5">
            <Toggle
              label="Streaming"
              hint="Watch in the browser. Turning this off disables playback but keeps browsing and downloads."
              checked={draft.streaming_enabled}
              onChange={(value) => patch('streaming_enabled', value)}
            />
            <Toggle
              label="Midnight"
              hint="Reveals the adult category in the browse tabs. Off by default."
              checked={draft.mature_content_enabled}
              onChange={(value) => patch('mature_content_enabled', value)}
              tone="danger"
            />
            <Toggle
              label="Addons"
              hint="Allow external addon manifests to add catalogues."
              checked={draft.addons_enabled}
              onChange={(value) => patch('addons_enabled', value)}
            />
            <Toggle
              label="Autoplay next episode"
              hint="Roll straight into the next episode when one finishes."
              checked={draft.autoplay_next_episode}
              onChange={(value) => patch('autoplay_next_episode', value)}
            />
          </div>
        </section>

        <ProviderSection
          draft={draft}
          providers={providers.data}
          pending={providers.isPending}
          onPatch={patch}
        />

        <StorageSection draft={draft} onPatch={patch} />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Sections                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Per-provider switches.
 *
 * A provider marked unavailable -- a BDIX source that failed its reachability
 * probe, say -- has its toggle disabled with the reason shown. Offering a switch
 * that cannot do anything is worse than showing the state plainly.
 */
function ProviderSection({
  draft,
  providers,
  pending,
  onPatch,
}: {
  draft: Settings;
  providers: ReturnType<typeof useProviders>['data'];
  pending: boolean;
  onPatch: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}) {
  const [probing, setProbing] = useState(false);

  const probe = async () => {
    setProbing(true);
    try {
      const result = await api.probeBdix();
      useUiStore
        .getState()
        .notify(
          'success',
          `BDIX probe: CircleFTP ${result.circleftp ? 'reachable' : 'unreachable'}, DhakaFlix ${
            result.dhakaflix ? 'reachable' : 'unreachable'
          }`,
        );
    } catch (error) {
      notifyError(error);
    } finally {
      setProbing(false);
    }
  };

  return (
    <section>
      <SectionHeading
        id="heading-providers"
        title="Providers"
        subtitle="Which sources search and discovery draw from."
        action={
          <button
            type="button"
            onClick={probe}
            disabled={probing}
            className="inline-flex items-center gap-2 rounded-full border border-border-default px-3.5 py-1.5 text-[12.5px] font-medium text-fg-muted transition hover:border-accent hover:text-accent disabled:opacity-50"
          >
            {probing && <Spinner className="size-3" />}
            Test BDIX
          </button>
        }
      />

      {pending ? (
        <div className="skeleton h-40 rounded-card" />
      ) : (
        <div className="space-y-1.5">
          {(providers ?? []).map((provider) => {
            const key = TOGGLE_KEY[provider.kind];

            return (
              <div key={provider.kind} className="surface rounded-card px-4 py-3">
                <Toggle
                  label={provider.label}
                  hint={
                    provider.available
                      ? undefined
                      : 'Unreachable right now. BDIX sources only answer on a local ISP network.'
                  }
                  // Coerced to a boolean rather than passed through: `draft[key]`
                  // is typed as the union of every `Settings` field, which
                  // includes strings and numbers for the non-boolean ones.
                  checked={key ? Boolean(draft[key]) : false}
                  disabled={!key || !provider.available}
                  onChange={(value) => {
                    // Narrowed here too. The `Toggle` callback only fires from a
                    // rendered checkbox, and `key` is guaranteed by the guard
                    // that disables it, but the compiler cannot see that.
                    if (key) onPatch(key, value as Settings[typeof key]);
                  }}
                />

                {/* Radio for the search provider. One source at a time. */}
                <label className="mt-2.5 flex cursor-pointer items-center gap-2 border-t border-border-subtle pt-2.5 text-[12.5px] text-fg-muted hover:text-fg-default">
                  <input
                    type="radio"
                    name="active-provider"
                    checked={draft.active_provider === provider.kind}
                    disabled={!provider.available || !provider.capabilities.supports_search}
                    onChange={() => {
                      onPatch('active_provider', provider.kind);
                      localStorage.setItem('novaflix_active_provider', provider.kind);
                    }}
                    className="accent-[var(--accent)]"
                  />
                  <span className={draft.active_provider === provider.kind ? 'font-bold text-accent' : ''}>
                    Use for search {draft.active_provider === provider.kind ? '(Active)' : ''}
                  </span>
                </label>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Which `Config` field backs each provider's on/off switch. */
const TOGGLE_KEY: Partial<Record<ProviderKind, keyof Settings>> = {
  moviebox: 'moviebox_enabled',
  fourkhdhub: 'fourkhdhub_enabled',
  dramachi: 'dramachi_enabled',
  bdix_circleftp: 'bdix_circleftp_enabled',
  bdix_dhakaflix: 'bdix_dhakaflix_enabled',
};

function StorageSection({
  draft,
  onPatch,
}: {
  draft: Settings;
  onPatch: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}) {
  const [clearing, setClearing] = useState(false);

  const clear = async () => {
    setClearing(true);
    try {
      const result = await api.clearCache();
      useUiStore
        .getState()
        .notify('success', `Cache cleared, ${formatFreed(result.freed_bytes)} freed`);
    } catch (error) {
      notifyError(error);
    } finally {
      setClearing(false);
    }
  };

  return (
    <section>
      <SectionHeading id="heading-storage" title="Storage" />

      <label className="block">
        <span className="text-[13px] font-medium text-fg-default">Download folder</span>
        <input
          type="text"
          value={draft.download_dir ?? ''}
          placeholder="Leave empty for the default"
          onChange={(event) => onPatch('download_dir', event.target.value || null)}
          className="mt-1.5 w-full rounded-card border border-border-default bg-bg-surface px-3.5 py-2.5 text-[13px] text-fg-default outline-none transition placeholder:text-fg-subtle focus:border-accent"
        />
        <span className="mt-1.5 block text-[11.5px] text-fg-subtle">
          A folder path on this machine. Leave empty to use the app's own folder.
        </span>
      </label>

      <button
        type="button"
        onClick={clear}
        disabled={clearing}
        className="mt-4 inline-flex items-center gap-2 rounded-full border border-border-default px-4 py-2 text-[12.5px] font-medium text-fg-muted transition hover:border-danger hover:text-danger disabled:opacity-50"
      >
        {clearing ? <Spinner className="size-3" /> : <Trash2 className="size-3.5" />}
        Clear cached catalogue
      </button>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Small shared pieces                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A labelled switch.
 *
 * A real checkbox underneath a styled track rather than a `role="switch"` div, so
 * it is focusable, responds to Space, and is announced correctly without any of
 * the keyboard handling being reimplemented.
 */
function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
  tone = 'default',
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  tone?: 'default' | 'danger';
}) {
  return (
    <label
      className={`flex items-start justify-between gap-4 rounded-card border border-border-subtle bg-bg-surface px-4 py-3 ${
        disabled ? 'opacity-50' : ''
      }`}
    >
      <span className="min-w-0">
        <span
          className={`block text-[13px] font-medium ${
            tone === 'danger' ? 'text-danger' : 'text-fg-default'
          }`}
        >
          {label}
        </span>
        {hint && <span className="mt-0.5 block text-[11.5px] text-fg-subtle">{hint}</span>}
      </span>

      <span className="relative mt-0.5 shrink-0">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="peer sr-only"
        />
        <span
          aria-hidden="true"
          className="block h-5 w-9 rounded-full bg-bg-raised transition peer-checked:bg-accent peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent"
        />
        <span
          aria-hidden="true"
          className="absolute left-0.5 top-0.5 size-4 rounded-full bg-fg-muted transition-transform peer-checked:translate-x-4 peer-checked:bg-accent-contrast"
        />
      </span>
    </label>
  );
}

function formatFreed(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'nothing';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}