import { isSameDay } from "date-fns/isSameDay";
import { startOfDay } from "date-fns/startOfDay";
import { useEffect, useRef, useState } from "react";

export function useToday() {
  const [today, setToday] = useState(startOfDay(new Date()));
  const timer = useRef<number>(null);
  useEffect(() => {
    timer.current = window.setInterval(() => {
      setToday((prev) => {
        const next = startOfDay(new Date());
        return isSameDay(prev, next) ? prev : next;
      });
    }, 1000);
    return () => window.clearInterval(timer.current!);
  }, []);
  return today;
}
