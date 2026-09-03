/**
 * Fullscreen ambient looping background video (muted, autoplay). Shared by
 * the landing hero and the auth (login / onboarding) screens so both
 * surfaces read as one design. Content sits above it at z-10.
 *
 * The clip is a slow push-in over the "handwritten ledgers to AI city"
 * artwork, encoded as a ping-pong (forward then reverse) sequence so it
 * cycles with no jump cut. Its centre strip is deliberately soft and light
 * so the hero copy stays readable on top; see Hero.tsx for the scrim.
 */
export function VideoBackdrop() {
  return (
    <video
      className="absolute inset-0 z-0 h-full w-full object-cover"
      autoPlay
      muted
      loop
      playsInline
    >
      <source src="/videos/hero-bg.webm" type="video/webm" />
      <source src="/videos/hero-bg.mp4" type="video/mp4" />
    </video>
  );
}
