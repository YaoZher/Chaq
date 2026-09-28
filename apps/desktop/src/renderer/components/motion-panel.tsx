import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import "./motion-panel.css";

type MotionPanelProps = Omit<HTMLAttributes<HTMLDivElement>, "children" | "hidden" | "aria-hidden"> & {
  active: boolean;
  children: ReactNode;
  unmountOnExit?: boolean;
};

type Phase = "entering" | "visible" | "exiting" | "hidden";

/** A visited page keeps its drafts and scroll position while inactive. */
export function MotionPanel({ active, children, unmountOnExit = false, className = "", ...props }: MotionPanelProps) {
  const element = useRef<HTMLDivElement>(null);
  const [visited, setVisited] = useState(active);
  const [phase, setPhase] = useState<Phase>(active ? "entering" : "hidden");
  const [preference] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)"));
  const [reducedMotion, setReducedMotion] = useState(preference.matches);

  useEffect(() => {
    const update = () => setReducedMotion(preference.matches);
    preference.addEventListener("change", update);
    update();
    return () => preference.removeEventListener("change", update);
  }, [preference]);

  useLayoutEffect(() => {
    const panel = element.current;
    if (!panel) return;
    if (!active) {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && panel.contains(focused)) focused.blur();
    }
    panel.inert = !active;
    if (active) {
      setVisited(true);
      setPhase(reducedMotion ? "visible" : "entering");
    } else {
      setPhase((current) => current === "hidden" || reducedMotion ? "hidden" : "exiting");
    }

    if (reducedMotion) return;
    // Cancel this completion whenever navigation changes, including a reversal mid-exit.
    const completion = window.setTimeout(() => setPhase(active ? "visible" : "hidden"), active ? 240 : 180);
    return () => window.clearTimeout(completion);
  }, [active, reducedMotion]);

  const hidden = !active && phase === "hidden";
  const renderChildren = (active || visited) && !(unmountOnExit && hidden);
  if (!active && !visited) return null;

  return (
    <div {...props} ref={element}
      className={`motion-panel ${className}`.trim()} data-motion={phase}
      data-motion-active={active ? "true" : "false"} hidden={hidden} aria-hidden={active ? undefined : true}>
      {renderChildren ? children : null}
    </div>
  );
}
