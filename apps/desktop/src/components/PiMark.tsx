import piMarkDark from "../assets/pi-mark-dark.png";
import piMarkLight from "../assets/pi-mark-light.png";

export function PiMark({ className = "" }: { className?: string }) {
  return (
    <span className={`relative inline-block shrink-0 ${className}`} aria-hidden="true">
      <img
        src={piMarkLight}
        alt=""
        className="pi-mark-light absolute inset-0 size-full object-contain"
      />
      <img
        src={piMarkDark}
        alt=""
        className="pi-mark-dark absolute inset-0 size-full object-contain"
      />
    </span>
  );
}
