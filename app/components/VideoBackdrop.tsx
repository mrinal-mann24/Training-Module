const VIDEO_SRC =
  "https://pollen-batch-41236914.figma.site/_components/v2/f0ee2dae7671c170c34f12e31c4cb41418976c98/769c564298c132f7919405cd9f17c1b1231f341d.769c5642.mp4";

/**
 * Ambient looping background video with a white-to-transparent top fade so
 * the nav and headline stay legible. Shared by the landing hero and the
 * auth (login / onboarding) screens so both surfaces read as one design.
 */
export function VideoBackdrop() {
  return (
    <>
      <video
        className="absolute inset-0 z-0 h-full w-full object-cover"
        src={VIDEO_SRC}
        autoPlay
        muted
        loop
        playsInline
      />
      <div
        className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-[687px]"
        style={{
          background:
            "linear-gradient(180deg, rgba(255,255,255,1) 0%, rgba(255,255,255,0) 100%)",
        }}
      />
    </>
  );
}
