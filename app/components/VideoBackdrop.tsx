/**
 * Fullscreen ambient looping background video (muted, autoplay). Shared by
 * the landing hero and the auth (login / onboarding) screens so both
 * surfaces read as one design. Content sits above it at z-10.
 *
 * The clip is the night-surface hero video the user supplied, served from
 * CloudFront. It is deliberately NOT the older local `/videos/hero-bg.*`
 * pair — that was the pale "handwritten ledgers to AI city" artwork for the
 * white theme, and it is left in `public/videos` untouched.
 *
 * It plays at full opacity with no overlay on landscape viewports, as
 * specified: the clip is a near-black field with a soft grey ribbon, and the
 * crop keeps that ribbon clear of the copy. `.night-scrim` is inert there
 * and only paints below `lg`, where the portrait crop drags the ribbon
 * across the text; see the note on that rule in `globals.css`.
 */
const HERO_VIDEO_SRC =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260818_072341_50851634-bbc3-4c33-9acc-7647d4db44aa.mp4";

export function VideoBackdrop() {
  return (
    <div aria-hidden="true" className="absolute inset-0 z-0 overflow-hidden">
      <video
        className="h-full w-full object-cover"
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        src={HERO_VIDEO_SRC}
      />

      <div className="night-scrim" />
    </div>
  );
}
