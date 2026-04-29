import { useMutation, useSuspenseQuery } from "@apollo/client/react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { graphql, type ResultOf } from "../../../graphql";
import { PlanningYearViewDocument } from "../$year";

const PlanningTaxRatesDialogDocument = graphql(`
  query PlanningTaxRatesDialog($year: ID!) {
    planningYear(id: $year) {
      id
      taxRates {
        ... on PlanningYearTaxRatesUK {
          rateBasic
          rateHigher
          rateAdditional
          thresholdBasic
          thresholdHigher
          thresholdAdditional
          rateNicMain
          rateNicAdditional
          thresholdNicPrimary
          thresholdNicUpperEarnings
          rateStudentLoanPlan2
          thresholdStudentLoanPlan2
          thresholdPersonalAllowanceTaper
          statutoryParentalPayWeekly
        }
      }
    }
  }
`);

const PlanningYearSetDocument = graphql(`
  mutation PlanningYearSet($year: ID!, $rates: PlanningYearTaxRatesUKInput!) {
    planningYearSet(year: $year, taxRates: { uk: $rates }) {
      id
    }
  }
`);

export const Route = createFileRoute("/planning/$year/tax-rates")({
  component: PlanningTaxRatesDialog,
});

type CurrentRates = Extract<
  NonNullable<
    NonNullable<
      ResultOf<typeof PlanningTaxRatesDialogDocument>["planningYear"]
    >["taxRates"]
  >,
  { __typename?: "PlanningYearTaxRatesUK" }
>;

/** Defaults for a fresh UK FY — 2024/25 numbers. User can override any. */
const DEFAULT_RATES = {
  rateBasic: "20",
  rateHigher: "40",
  rateAdditional: "45",
  thresholdBasic: "12570",
  thresholdHigher: "50270",
  thresholdAdditional: "125000",
  rateNicMain: "8",
  rateNicAdditional: "2",
  thresholdNicPrimary: "12570",
  thresholdNicUpperEarnings: "50270",
  rateStudentLoanPlan2: "9",
  thresholdStudentLoanPlan2: "27295",
  thresholdPersonalAllowanceTaper: "100000",
  statutoryParentalPayWeekly: "187.18",
};

type FormValues = typeof DEFAULT_RATES;

function ratesToForm(r: CurrentRates): FormValues {
  // Stored rates are 0-1 fractions → display as percentages.
  // Stored thresholds are pence → display as pounds.
  return {
    rateBasic: String(r.rateBasic * 100),
    rateHigher: String(r.rateHigher * 100),
    rateAdditional: String(r.rateAdditional * 100),
    thresholdBasic: String(r.thresholdBasic / 100),
    thresholdHigher: String(r.thresholdHigher / 100),
    thresholdAdditional: String(r.thresholdAdditional / 100),
    rateNicMain: String(r.rateNicMain * 100),
    rateNicAdditional: String(r.rateNicAdditional * 100),
    thresholdNicPrimary: String(r.thresholdNicPrimary / 100),
    thresholdNicUpperEarnings: String(r.thresholdNicUpperEarnings / 100),
    rateStudentLoanPlan2: String(r.rateStudentLoanPlan2 * 100),
    thresholdStudentLoanPlan2: String(r.thresholdStudentLoanPlan2 / 100),
    thresholdPersonalAllowanceTaper: String(
      r.thresholdPersonalAllowanceTaper / 100,
    ),
    statutoryParentalPayWeekly: String(r.statutoryParentalPayWeekly / 100),
  };
}

function formToRates(v: FormValues) {
  const pct = (s: string) => (Number(s) || 0) / 100;
  const pounds = (s: string) => Math.round((Number(s) || 0) * 100);
  return {
    rateBasic: pct(v.rateBasic),
    rateHigher: pct(v.rateHigher),
    rateAdditional: pct(v.rateAdditional),
    thresholdBasic: pounds(v.thresholdBasic),
    thresholdHigher: pounds(v.thresholdHigher),
    thresholdAdditional: pounds(v.thresholdAdditional),
    rateNicMain: pct(v.rateNicMain),
    rateNicAdditional: pct(v.rateNicAdditional),
    thresholdNicPrimary: pounds(v.thresholdNicPrimary),
    thresholdNicUpperEarnings: pounds(v.thresholdNicUpperEarnings),
    rateStudentLoanPlan2: pct(v.rateStudentLoanPlan2),
    thresholdStudentLoanPlan2: pounds(v.thresholdStudentLoanPlan2),
    thresholdPersonalAllowanceTaper: pounds(v.thresholdPersonalAllowanceTaper),
    statutoryParentalPayWeekly: pounds(v.statutoryParentalPayWeekly),
  };
}

function PlanningTaxRatesDialog() {
  const { year } = Route.useParams();
  const navigate = useNavigate();
  const { data } = useSuspenseQuery(PlanningTaxRatesDialogDocument, {
    variables: { year },
  });

  const current = data.planningYear?.taxRates as CurrentRates | null;
  const [values, setValues] = useState<FormValues>(() =>
    current ? ratesToForm(current) : DEFAULT_RATES,
  );

  const [mutate, { loading }] = useMutation(PlanningYearSetDocument, {
    refetchQueries: [
      { query: PlanningTaxRatesDialogDocument, variables: { year } },
      { query: PlanningYearViewDocument, variables: { id: year } },
    ],
  });

  const close = () =>
    void navigate({ to: "/planning/$year", params: { year } });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    await mutate({ variables: { year, rates: formToRates(values) } });
    toast.success(`Tax rates saved for FY ${year}`);
    close();
  };

  const patch = (p: Partial<FormValues>) => setValues((v) => ({ ...v, ...p }));

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>UK tax rates</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <Section title="Income tax">
            <div className="grid gap-3 sm:grid-cols-3">
              <Pct
                label="Basic rate"
                value={values.rateBasic}
                onChange={(v) => patch({ rateBasic: v })}
              />
              <Pct
                label="Higher rate"
                value={values.rateHigher}
                onChange={(v) => patch({ rateHigher: v })}
              />
              <Pct
                label="Additional rate"
                value={values.rateAdditional}
                onChange={(v) => patch({ rateAdditional: v })}
              />
              <Pounds
                label="Basic band ceiling"
                value={values.thresholdBasic}
                onChange={(v) => patch({ thresholdBasic: v })}
              />
              <Pounds
                label="Higher band ceiling"
                value={values.thresholdHigher}
                onChange={(v) => patch({ thresholdHigher: v })}
              />
              <Pounds
                label="Additional band starts at"
                value={values.thresholdAdditional}
                onChange={(v) => patch({ thresholdAdditional: v })}
              />
              <Pounds
                label="Personal allowance taper from"
                value={values.thresholdPersonalAllowanceTaper}
                onChange={(v) => patch({ thresholdPersonalAllowanceTaper: v })}
              />
            </div>
          </Section>
          <Section title="National insurance">
            <div className="grid gap-3 sm:grid-cols-2">
              <Pct
                label="Main rate"
                value={values.rateNicMain}
                onChange={(v) => patch({ rateNicMain: v })}
              />
              <Pct
                label="Additional rate"
                value={values.rateNicAdditional}
                onChange={(v) => patch({ rateNicAdditional: v })}
              />
              <Pounds
                label="Primary threshold"
                value={values.thresholdNicPrimary}
                onChange={(v) => patch({ thresholdNicPrimary: v })}
              />
              <Pounds
                label="Upper earnings limit"
                value={values.thresholdNicUpperEarnings}
                onChange={(v) => patch({ thresholdNicUpperEarnings: v })}
              />
            </div>
          </Section>
          <Section title="Parental leave">
            <div className="grid gap-3 sm:grid-cols-2">
              <Pounds
                label="Statutory weekly rate"
                value={values.statutoryParentalPayWeekly}
                onChange={(v) => patch({ statutoryParentalPayWeekly: v })}
              />
            </div>
          </Section>
          <Section title="Student loan (plan 2)">
            <div className="grid gap-3 sm:grid-cols-2">
              <Pct
                label="Rate"
                value={values.rateStudentLoanPlan2}
                onChange={(v) => patch({ rateStudentLoanPlan2: v })}
              />
              <Pounds
                label="Threshold"
                value={values.thresholdStudentLoanPlan2}
                onChange={(v) => patch({ thresholdStudentLoanPlan2: v })}
              />
            </div>
          </Section>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="space-y-2 rounded-md border p-3">
      <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

function Pct({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        inputMode="decimal"
        step="0.01"
        min="0"
        max="100"
        endAdornment="%"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function Pounds({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        inputMode="decimal"
        step="1"
        min="0"
        currency="GBP"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
