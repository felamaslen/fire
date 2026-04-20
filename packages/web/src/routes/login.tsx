import { useMutation, useQuery } from "@apollo/client/react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Delete, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  DemoLoginDocument,
  DemosDocument,
  LoginDocument,
} from "../auth/documents";
import { setToken } from "../auth/token";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { cn } from "../lib/cn";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

const PIN_LENGTH = 4;

function LoginPage() {
  const navigate = useNavigate();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);

  const { data: demosData } = useQuery(DemosDocument);
  const [loginMutation] = useMutation(LoginDocument);
  const [demoLoginMutation] = useMutation(DemoLoginDocument);

  const submitPin = useCallback(
    async (value: string) => {
      setBusy(true);
      try {
        const { data } = await loginMutation({
          variables: { pin: Number(value) },
        });
        if (!data?.login.token) throw new Error("No token returned");
        setToken(data.login.token);
        await navigate({ to: "/" });
      } catch (err) {
        setShake(true);
        setPin("");
        window.setTimeout(() => setShake(false), 500);
        toast.error(err instanceof Error ? err.message : "Login failed");
      } finally {
        setBusy(false);
      }
    },
    [loginMutation, navigate],
  );

  // Submit automatically as soon as all four digits are entered.
  useEffect(() => {
    if (pin.length === PIN_LENGTH && !busy) {
      void submitPin(pin);
    }
  }, [pin, busy, submitPin]);

  // Hardware keyboard — digits / Backspace / Delete all drive the same state as the on-screen pad.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy) return;
      if (/^[0-9]$/u.test(e.key)) {
        setPin((p) => (p.length >= PIN_LENGTH ? p : p + e.key));
        e.preventDefault();
      } else if (e.key === "Backspace" || e.key === "Delete") {
        setPin((p) => p.slice(0, -1));
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy]);

  const [pendingDemo, setPendingDemo] = useState<string | null>(null);

  const demoLogin = async (id: string) => {
    setBusy(true);
    setPendingDemo(id);
    try {
      const { data } = await demoLoginMutation({ variables: { id } });
      if (!data?.demoLogin.token) throw new Error("No token returned");
      setToken(data.demoLogin.token);
      await navigate({ to: "/" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Demo login failed");
    } finally {
      setBusy(false);
      setPendingDemo(null);
    }
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">fire</h1>

      <Card>
        <CardHeader>
          <CardTitle>Enter PIN</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-6">
          <PinDisplay value={pin} shake={shake} />
          <PinPad
            onDigit={(d) =>
              setPin((p) => (p.length >= PIN_LENGTH || busy ? p : p + d))
            }
            onDelete={() => setPin((p) => (busy ? p : p.slice(0, -1)))}
            disabled={busy}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Or try a demo</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 md:grid-cols-2">
          {demosData?.demos?.map((demo) => {
            const isPending = pendingDemo === demo.id;
            return (
              <button
                key={demo.id}
                type="button"
                disabled={busy}
                onClick={() => {
                  void demoLogin(demo.id);
                }}
                className="flex cursor-pointer flex-col items-start gap-1 rounded-md border p-3 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="flex w-full items-center gap-2">
                  <span className="flex-1 text-sm font-medium">
                    {demo.name}
                  </span>
                  {isPending && (
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  {demo.description}
                </span>
              </button>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}

function PinDisplay({ value, shake }: { value: string; shake: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center gap-4",
        shake && "animate-[shake_400ms_ease-in-out]",
      )}
    >
      {Array.from({ length: PIN_LENGTH }).map((_, i) => (
        <div
          key={i}
          className={cn(
            "h-4 w-4 rounded-full border-2 border-muted-foreground transition-colors",
            i < value.length && "bg-foreground border-foreground",
          )}
        />
      ))}
    </div>
  );
}

function PinPad({
  onDigit,
  onDelete,
  disabled,
}: {
  onDigit: (d: string) => void;
  onDelete: () => void;
  disabled: boolean;
}) {
  const grid = [
    ["1", "2", "3"],
    ["4", "5", "6"],
    ["7", "8", "9"],
    ["", "0", "⌫"],
  ];
  const rootRef = useRef<HTMLDivElement>(null);
  // Keep focus inside the pad so the hardware keyboard handler picks up keys
  // without the user having to click into a specific input.
  useEffect(() => {
    rootRef.current?.focus();
  }, []);
  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="grid grid-cols-3 gap-3 outline-none"
    >
      {grid.flat().map((key, idx) => {
        if (key === "") return <div key={idx} />;
        const isDelete = key === "⌫";
        return (
          <button
            key={idx}
            type="button"
            disabled={disabled}
            onClick={() => (isDelete ? onDelete() : onDigit(key))}
            className={cn(
              "h-16 w-16 cursor-pointer rounded-full border bg-background text-lg font-medium shadow-sm transition-colors",
              "hover:bg-accent active:bg-accent/70 disabled:pointer-events-none disabled:opacity-50",
              isDelete && "text-muted-foreground",
            )}
            aria-label={isDelete ? "Delete" : `Digit ${key}`}
          >
            {isDelete ? <Delete className="mx-auto" /> : key}
          </button>
        );
      })}
    </div>
  );
}
