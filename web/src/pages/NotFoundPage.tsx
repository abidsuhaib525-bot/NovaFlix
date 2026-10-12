/**
 * 404.
 *
 * Offers the categories rather than only a link home, because a mistyped or stale
 * deep link to a title is the common case here -- tabs, providers and ids have
 * all changed over time -- and the category grid is a better guess at what the
 * user wanted than the home page's mixed feed.
 */

import { Compass } from 'lucide-react';
import { Link } from 'react-router-dom';

import { EmptyState, SectionHeading } from '@/components/common/StateBlocks';
import { useHomepageTabs } from '@/hooks/useCatalog';
import { paths } from '@/lib/routes';

export function NotFoundPage() {
  const tabs = useHomepageTabs();

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-16 sm:px-6 lg:px-8">
      <EmptyState
        icon={<Compass className="size-9" aria-hidden="true" />}
        title="Page not found"
        hint="That address does not match anything in MovieBox. It may have been from an older version."
        action={
          <Link
            to={paths.home()}
            className="rounded-full bg-accent px-5 py-2.5 text-[13px] font-semibold text-accent-contrast transition hover:bg-accent-hover"
          >
            Back to home
          </Link>
        }
      />

      {(tabs.data?.length ?? 0) > 0 && (
        <section className="mx-auto mt-10 max-w-3xl">
          <SectionHeading id="heading-notfound-categories" title="Or browse a category" />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {tabs.data!.map((tab) => (
              <Link
                key={tab.id}
                to={paths.tab(tab.id)}
                className="surface card-hover rounded-card px-4 py-3"
              >
                <p className="truncate text-[13.5px] font-semibold text-fg-default">
                  {tab.label}
                </p>
                <p className="mt-0.5 line-clamp-1 text-[11.5px] text-fg-subtle">{tab.blurb}</p>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}