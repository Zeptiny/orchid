import { memo, type ReactNode } from 'react';

interface DeferredSurfaceProps {
  isVisible: boolean;
  children: ReactNode;
}

function hiddenSurfacePropsAreEqual(
  previous: DeferredSurfaceProps,
  next: DeferredSurfaceProps,
): boolean {
  return !previous.isVisible && !next.isVisible;
}

/**
 * Preserve a mounted presentation subtree while deferring parent-driven renders
 * until its containing surface becomes visible again.
 */
export const DeferredSurface = memo(function DeferredSurface({
  children,
}: DeferredSurfaceProps) {
  return <>{children}</>;
}, hiddenSurfacePropsAreEqual);
