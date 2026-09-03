/**
 * Fullscreen ambient looping background video (muted, autoplay). Shared by
 * the landing hero and the auth (login / onboarding) screens so both
 * surfaces read as one design. Content sits above it at z-10.
 *
 * The clip is a slow push-in over the "handwritten ledgers to AI city"
 * artwork, encoded as a ping-pong (forward then reverse) sequence so it
 * cycles with no jump cut. It is a bright, high-key illustration, so it
 * carries its own scrim (`.night-scrim`) grading down to solid black at the
 * bottom — without it the white hero copy has nothing to sit on. The two
 * always ship together, which is why the scrim lives here and not in Hero.
 */
export function VideoBackdrop() {
  return (
    <div aria-hidden="true" className="absolute inset-0 z-0 overflow-hidden">
      <video
        className="h-full w-full object-cover"
        autoPlay
        muted
        loop
        playsInline
      >
        <source src="/videos/hero-bg.webm" type="video/webm" />
        <source src="/videos/hero-bg.mp4" type="video/mp4" />
      </video>

      <div className="night-scrim" />
    </div>
  );
}
