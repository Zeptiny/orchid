import { useEffect, useId, useMemo, useRef } from 'react';
import { Button } from '../ui/Button';

export interface ResultPagerProps {
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  label?: string;
}

/** Small, focus-preserving progressive disclosure control shared by result bodies. */
export function ResultPager({
  total,
  page,
  pageSize,
  onPageChange,
  label = 'result items',
}: ResultPagerProps) {
  const statusId = useId();
  const statusRef = useRef<HTMLSpanElement>(null);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  const start = total === 0 ? 0 : currentPage * pageSize + 1;
  const end = Math.min(total, (currentPage + 1) * pageSize);

  useEffect(() => {
    if (statusRef.current) statusRef.current.textContent = `${start}-${end} of ${total} ${label}`;
  }, [start, end, total, label]);

  const pages = useMemo(() => {
    const result: number[] = [];
    for (let index = 0; index < pageCount; index += 1) result.push(index);
    return result;
  }, [pageCount]);

  if (total <= pageSize) return null;

  return (
    <nav className="join mt-2 flex flex-wrap items-center gap-1" aria-label={`Paginate ${label}`}>
      <Button
        size="xs"
        variant="ghost"
        className="join-item"
        onClick={() => onPageChange(currentPage - 1)}
        disabled={currentPage === 0}
        aria-label="Previous page"
        aria-describedby={statusId}
      >
        Previous
      </Button>
      {pages.length <= 7 ? pages.map((index) => (
        <Button
          key={index}
          size="xs"
          variant={index === currentPage ? 'neutral' : 'ghost'}
          className="join-item"
          onClick={() => onPageChange(index)}
          aria-current={index === currentPage ? 'page' : undefined}
          aria-label={`Page ${index + 1}`}
        >
          {index + 1}
        </Button>
      )) : (
        <span className="join-item btn btn-xs btn-ghost" aria-hidden>{currentPage + 1} / {pageCount}</span>
      )}
      <Button
        size="xs"
        variant="ghost"
        className="join-item"
        onClick={() => onPageChange(currentPage + 1)}
        disabled={currentPage >= pageCount - 1}
        aria-label="Next page"
        aria-describedby={statusId}
      >
        Next
      </Button>
      <span ref={statusRef} id={statusId} className="sr-only" role="status" aria-live="polite">
        {start}-{end} of {total} {label}
      </span>
    </nav>
  );
}
