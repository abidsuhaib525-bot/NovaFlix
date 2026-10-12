/**
 * Stremio-style addons.
 *
 * An addon is a manifest URL that contributes catalogues and, for addons that
 * provide their own streams, titles that play like any other source. The server
 * keeps the installed set in `addons.json`, proxies each catalogue (addons have
 * no CORS headers, so the browser cannot fetch them directly) and installs
 * replace any earlier copy of the same URL, which makes a version bump just
 * another install.
 *
 * The page does the management half: install, toggle, uninstall and browse. The
 * browse targets mirror `curated_catalog_presets()` on the server — "top" and
 * "imdbRating" catalogues per installed catalog addon — so clicking one lands
 * on a real catalogue the addon serves rather than guessing at ids.
 */

import { ArrowLeft, Package, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  EmptyState,
  ErrorState,
  PageHeading,
  SectionHeading,
  SkeletonGrid,
  Spinner,
} from '@/components/common/StateBlocks';
import { PosterCard } from '@/components/media/PosterCard';
import {
  useAddAddon,
  useAddonCatalog,
  useAddons,
  useRemoveAddon,
  useSettings,
  useToggleAddon,
} from '@/hooks/useCatalog';
import { paths } from '@/lib/routes';
import type { AddonCatalogTarget, InstalledAddon } from '@/types';
import { notifyError, useUiStore } from '@/store/ui';

/** How many browse buttons to offer before the grid gets busy. */
const MAX_TARGETS = 6;

/** A catalogue button: the fetch target plus the label the button shows. */
type BrowseTarget = AddonCatalogTarget & { label: string };

export function AddonsPage() {
  const settings = useSettings();
  const addons = useAddons();
  const install = useAddAddon();
  const toggle = useToggleAddon();
  const remove = useRemoveAddon();

  const [manifest, setManifest] = useState('');
  const [target, setTarget] = useState<BrowseTarget | null>(null);

  const browseTargets = useMemo(() => catalogTargets(addons.data ?? []), [addons.data]);
  const catalog = useAddonCatalog(target);

  // Only once the settings have actually loaded, so a brief flash of the banner
  // on first paint is impossible.
  const addonsEnabled = settings.data ? settings.data.addons_enabled : true;

  const onInstall = () => {
    if (manifest.trim() === '') return;
    install.mutate(manifest, {
      onSuccess: (addon) => {
        useUiStore.getState().notify('success', `${addon.name} installed`);
        setManifest('');
      },
      onError: notifyError,
    });
  };

  return (
    <div className="mx-auto max-w-[1600px] px-4 pt-4 sm:px-6 lg:px-8">
      <PageHeading
        title="Addons"
        subtitle="Extra catalogues from the Stremio ecosystem, managed here."
      />

      {!addonsEnabled && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-card border border-warning/40 bg-warning/10 px-4 py-3">
          <div>
            <p className="text-[13px] font-medium text-fg-default">Addons are disabled in settings</p>
            <p className="mt-0.5 text-[12px] text-fg-muted">
              They can be installed but will not serve anything until you turn them on.
            </p>
          </div>
          <Link
            to={paths.settings()}
            className="rounded-full border border-border-default px-4 py-1.5 text-[12.5px] font-medium text-fg-muted transition hover:border-accent hover:text-accent"
          >
            Open settings
          </Link>
        </div>
      )}

      <InstallBox
        value={manifest}
        onChange={setManifest}
        onInstall={onInstall}
        busy={install.isPending}
      />

      <section className="mt-10">
        <SectionHeading
          id="heading-installed"
          title="Installed"
          subtitle={
            addons.data && addons.data.length > 0
              ? `${addons.data.length} addon${addons.data.length === 1 ? '' : 's'}`
              : undefined
          }
        />

        {addons.isPending ? (
          <div className="skeleton h-40 rounded-card" />
        ) : addons.data && addons.data.length > 0 ? (
          <ul className="space-y-1.5">
            {addons.data.map((addon) => (
              <AddonRow
                key={addon.manifest_url}
                addon={addon}
                onToggle={(enabled) => {
                  const index = addons.data!.findIndex(
                    (entry) => entry.manifest_url === addon.manifest_url,
                  );
                  if (index >= 0) toggle.mutate({ index, enabled });
                }}
                onRemove={() => {
                  const index = addons.data!.findIndex(
                    (entry) => entry.manifest_url === addon.manifest_url,
                  );
                  if (index >= 0) remove.mutate(index);
                }}
              />
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={<Package className="size-8" aria-hidden="true" />}
            title="No addons installed"
            hint="Install one by pasting its manifest URL above. Cinemeta (https://v3-cinemeta.strem.io/manifest.json) is a good first choice."
          />
        )}
      </section>

      {target ? (
        <section className="mt-10">
          <div className="flex items-center justify-between gap-3">
            <SectionHeading id="heading-catalog" title={target.label} />
            <button
              type="button"
              onClick={() => setTarget(null)}
              className="inline-flex items-center gap-1.5 rounded-full border border-border-default px-3.5 py-1.5 text-[12.5px] font-medium text-fg-muted transition hover:border-accent hover:text-accent"
            >
              <ArrowLeft className="size-3.5" aria-hidden="true" />
              All addons
            </button>
          </div>

          {catalog.isPending ? (
            <div className="mt-4">
              <SkeletonGrid />
            </div>
          ) : catalog.isError ? (
            <ErrorState
              error={catalog.error}
              onRetry={() => void catalog.refetch()}
              title="Could not load this catalogue"
            />
          ) : !catalog.data || catalog.data.length === 0 ? (
            <EmptyState
              title="Nothing here"
              hint="The addon returned an empty catalogue. Try a different one."
            />
          ) : (
            <div className="mt-4 grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
              {catalog.data.map((item) => (
                <PosterCard
                  key={`${item.id.provider}:${item.id.value}`}
                  item={item}
                  className="w-full"
                />
              ))}
            </div>
          )}
        </section>
      ) : (
        <section className="mt-10">
          <SectionHeading
            id="heading-catalogues"
            title="Browse catalogues"
            subtitle="Catalogues served by addons you have installed and enabled."
          />

          {browseTargets.length === 0 ? (
            <p className="text-[12.5px] text-fg-subtle">
              Nothing to browse yet. Install an addon that provides catalogues
              (Cinemeta is the classic one) and its entries appear here.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {browseTargets.map((entry) => (
                <button
                  key={`${entry.manifest_url}:${entry.type}:${entry.catalog_id}`}
                  type="button"
                  onClick={() => setTarget(entry)}
                  className="rounded-full border border-border-default bg-bg-surface px-4 py-2 text-[13px] font-medium text-fg-default transition hover:border-accent hover:text-accent"
                >
                  {entry.label}
                </button>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Install                                                                    */
/* -------------------------------------------------------------------------- */

function InstallBox({
  value,
  onChange,
  onInstall,
  busy,
}: {
  value: string;
  onChange: (url: string) => void;
  onInstall: () => void;
  busy: boolean;
}) {
  return (
    <section>
      <SectionHeading
        id="heading-install"
        title="Install"
        subtitle="A manifest URL, the same one you would add in Stremio."
      />

      <form
        onSubmit={(event) => {
          event.preventDefault();
          onInstall();
        }}
        className="flex flex-col gap-2 sm:flex-row"
      >
        <label htmlFor="addon-manifest" className="sr-only">
          Addon manifest URL
        </label>
        <input
          id="addon-manifest"
          type="url"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="https://example.com/manifest.json"
          className="min-w-0 flex-1 rounded-full border border-border-default bg-bg-surface px-4 py-2.5 text-[13px] text-fg-default outline-none transition placeholder:text-fg-subtle focus:border-accent"
        />
        <button
          type="submit"
          disabled={busy || value.trim() === ''}
          className="inline-flex items-center justify-center gap-2 rounded-full bg-accent px-5 py-2.5 text-[13px] font-semibold text-accent-contrast transition hover:bg-accent-hover disabled:pointer-events-none disabled:opacity-40"
        >
          {busy && <Spinner className="size-3.5" />}
          Install
        </button>
      </form>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* One installed addon                                                         */
/* -------------------------------------------------------------------------- */

function AddonRow({
  addon,
  onToggle,
  onRemove,
}: {
  addon: InstalledAddon;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
}) {
  const badges = [
    addon.provides_catalog ? 'Catalog' : null,
    addon.provides_meta ? 'Metadata' : null,
    addon.provides_stream ? 'Streams' : null,
  ].filter(Boolean);

  return (
    <li className="surface rounded-card px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 text-[13.5px] font-medium text-fg-default">
            {addon.name}
            {addon.version && (
              <span className="text-[11px] font-normal text-fg-subtle">v{addon.version}</span>
            )}
          </p>
          <p
            className="mt-0.5 truncate text-[11px] text-fg-subtle"
            title={addon.manifest_url}
          >
            {addon.manifest_url}
          </p>
          {addon.description && (
            <p className="mt-1 line-clamp-2 text-[12px] text-fg-muted">{addon.description}</p>
          )}
          {badges.length > 0 && (
            <p className="mt-2 flex flex-wrap gap-1.5">
              {badges.map((badge) => (
                <span
                  key={badge}
                  className="rounded-full border border-border-subtle bg-bg-surface px-2 py-0.5 text-[10.5px] font-medium text-fg-muted"
                >
                  {badge}
                </span>
              ))}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1 pl-3">
          <Switch
            checked={addon.enabled}
            onChange={onToggle}
            label={`Enable ${addon.name}`}
          />
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Uninstall ${addon.name}`}
            title="Uninstall"
            className="grid size-8 place-items-center rounded-full text-fg-subtle transition hover:bg-bg-hover hover:text-danger"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </div>
    </li>
  );
}

/**
 * A minimal on/off switch, the same shape as settings uses elsewhere.
 *
 * A real checkbox under a styled track, so it is focusable, answers Space, and
 * is announced correctly without reimplementing any keyboard handling.
 */
function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (enabled: boolean) => void;
  label: string;
}) {
  return (
    <label className="relative inline-block" title={label}>
      <input
        type="checkbox"
        checked={checked}
        aria-label={label}
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
    </label>
  );
}

/* -------------------------------------------------------------------------- */
/* Curated catalogue presets                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The catalogue buttons offered for the installed set.
 *
 * A mirror of the server's `curated_catalog_presets`: "top" (optionally
 * "imdbRating") per addon for the media types it advertises, with a couple of
 * extras for Cinemeta. Kept in the client so the labels read as buttons the
 * user clicks, while the fetch itself still goes through `/api/addons/catalog`.
 */
function catalogTargets(addons: InstalledAddon[]): BrowseTarget[] {
  const targets: BrowseTarget[] = [];

  for (const addon of addons) {
    if (!addon.enabled || !addon.provides_catalog) continue;

    const types = addon.types.map((entry) => entry.toLowerCase());
    const hasMovies = types.length === 0 || types.includes('movie');
    const hasSeries = types.length === 0 || types.includes('series');
    const isCore =
      addon.name.toLowerCase().includes('cinemeta') ||
      addon.manifest_url.toLowerCase().includes('cinemeta');
    const suffix =
      addons.length > 1 ? ` (${addon.name})` : '';

    if (hasMovies) {
      targets.push(browseTarget(addon, 'movie', 'top', `Top Movies${suffix}`));
    }
    if (hasSeries) {
      targets.push(browseTarget(addon, 'series', 'top', `Top Series${suffix}`));
    }
    if (hasMovies && isCore) {
      targets.push(
        browseTarget(addon, 'movie', 'imdbRating', `Top Rated Movies${suffix}`),
      );
    }
    if (hasSeries && isCore) {
      targets.push(
        browseTarget(addon, 'series', 'imdbRating', `Top Rated Series${suffix}`),
      );
    }
    if (targets.length >= MAX_TARGETS) break;
  }

  return targets;
}

function browseTarget(
  addon: InstalledAddon,
  type: string,
  catalogId: string,
  label: string,
): BrowseTarget {
  return {
    manifest_url: addon.manifest_url,
    type,
    catalog_id: catalogId,
    name: addon.name,
    label,
  };
}