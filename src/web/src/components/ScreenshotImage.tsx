import { useCallback, useEffect, useState } from 'react';

export function ScreenshotImage({ src, alt }: { src: string; alt: string }) {
  const [open, setOpen] = useState(false);

  const onKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
  }, []);

  useEffect(() => {
    if (open) {
      document.addEventListener('keydown', onKeyDown);
      return () => document.removeEventListener('keydown', onKeyDown);
    }
  }, [open, onKeyDown]);

  return (
    <>
      <img
        className="msg-tool-result__image"
        src={src}
        alt={alt}
        onClick={() => setOpen(true)}
      />
      {open && (
        <div className="lightbox" onClick={() => setOpen(false)}>
          <img className="lightbox__img" src={src} alt={alt} />
        </div>
      )}
    </>
  );
}
