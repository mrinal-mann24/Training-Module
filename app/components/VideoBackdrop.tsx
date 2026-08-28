const VIDEO_SRC =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260319_015952_e1deeb12-8fb7-4071-a42a-60779fc64ab6.mp4";

/**
 * Fullscreen ambient looping background video (muted, autoplay). Shared by
 * the landing hero and the auth (login / onboarding) screens so both
 * surfaces read as one design. Content sits above it at z-10.
 */
export function VideoBackdrop() {
  return (
    <video
      className="absolute inset-0 z-0 h-full w-full object-cover"
      src={VIDEO_SRC}
      autoPlay
      muted
      loop
      playsInline
    />
  );
}
