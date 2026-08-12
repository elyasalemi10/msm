"use client";

import { useEffect, useState } from "react";
import { Download, Loader2, CalendarIcon } from "lucide-react";
import { format } from "date-fns";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "sonner";
import { pdf } from "@react-pdf/renderer";
import { createElement } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/shared/date-picker";
import {
  getLevyHistory,
  getInsuranceStatus,
  getLotOwnerRegister,
  getCommunicationLog,
  getAuditTrail,
  getOCCertificateData,
  getOutstandingArrearsReport,
  getOwnerStatement,
  getTrustAccountSummary,
} from "@/lib/actions/reports";
import {
  outstandingArrearsToCsv,
  ownerStatementToCsv,
  trustAccountSummaryToCsv,
} from "@/lib/actions/reports-csv";
import {
  LevyHistoryReport,
  InsuranceStatusReport,
  LotRegisterReport,
  CommLogReport,
  AuditTrailReport,
  OutstandingArrearsReport,
  OwnerStatementReportPdf,
  TrustAccountSummaryReport,
} from "@/lib/pdf/templates/report";
import { OCCertificate } from "@/lib/pdf/templates/oc-certificate";

interface LotOption {
  id: string;
  lot_number: number;
  unit_number: string | null;
  owner_display_name: string | null;
}

type ReportType =
  | "levy_history"
  | "insurance_status"
  | "lot_register"
  | "communication_log"
  | "audit_trail"
  | "oc_certificate"
  | "outstanding_arrears"
  | "owner_statement"
  | "trust_account_summary";

const REPORTS: { id: ReportType; label: string; managerOnly: boolean }[] = [
  { id: "oc_certificate", label: "Owners Corporation Certificate", managerOnly: true },
  { id: "outstanding_arrears", label: "Outstanding arrears", managerOnly: true },
  { id: "owner_statement", label: "Owner statement", managerOnly: false },
  { id: "trust_account_summary", label: "Trust account summary", managerOnly: true },
  { id: "levy_history", label: "Levy history", managerOnly: false },
  { id: "insurance_status", label: "Insurance status", managerOnly: false },
  { id: "lot_register", label: "Lot owner register", managerOnly: false },
  { id: "communication_log", label: "Communication log", managerOnly: true },
  { id: "audit_trail", label: "Audit trail", managerOnly: true },
];

export function ReportsContent({
  ocId,
  ocName,
  ocAddress,
  ocPlanNumber,
  logoUrl,
  isLotOwner,
  lots,
}: {
  ocId: string;
  ocName: string;
  ocAddress: string;
  ocPlanNumber: string;
  logoUrl: string | null;
  isLotOwner: boolean;
  lots: LotOption[];
}) {
  const [reportType, setReportType] = useState<ReportType | "">("");
  const [selectedLotId, setSelectedLotId] = useState("");
  const [certLotId, setCertLotId] = useState("");
  const [certApplicant, setCertApplicant] = useState("");
  const [certEmail, setCertEmail] = useState("");
  const [certAppDate, setCertAppDate] = useState<Date>(new Date());
  const [certAppDateOpen, setCertAppDateOpen] = useState(false);
  // Editable certificate text fields
  const [certRepairs, setCertRepairs] = useState("n/a");
  const [certFunds, setCertFunds] = useState("n/a");
  const [certLiabilities, setCertLiabilities] = useState("n/a");
  const [certContracts, setCertContracts] = useState("n/a");
  const [certServices, setCertServices] = useState("n/a");
  const [certNotices, setCertNotices] = useState("n/a");
  const [certLegal, setCertLegal] = useState("n/a");
  // Editable fee fields (prefilled from server on lot select)
  const [certCurrentFees, setCertCurrentFees] = useState("n/a");
  const [certBillingCycle, setCertBillingCycle] = useState("quarterly");
  const [certFeesPaidUpTo, setCertFeesPaidUpTo] = useState("n/a");
  const [certUnpaidFees, setCertUnpaidFees] = useState("0.00");
  const [certLastAgm, setCertLastAgm] = useState<Date | undefined>(undefined);
  const [certLastAgmOpen, setCertLastAgmOpen] = useState(false);
  const [prefilling, setPrefilling] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  // PP7-B: shared date-range state for outstanding_arrears (as-of) +
  // owner_statement / trust_account_summary (from/to range).
  const todayIso = new Date().toISOString().slice(0, 10);
  const ninetyDaysAgoIso = new Date(Date.now() - 90 * 86400000)
    .toISOString()
    .slice(0, 10);
  const [asOfDate, setAsOfDate] = useState<string>(todayIso);
  const [rangeFrom, setRangeFrom] = useState<string>(ninetyDaysAgoIso);
  const [rangeTo, setRangeTo] = useState<string>(todayIso);
  // CSV holder for the 3 new reports (PDF holder is pdfUrl).
  const [csvBlobUrl, setCsvBlobUrl] = useState<string | null>(null);

  // Prefill fee fields when lot changes
  useEffect(() => {
    if (reportType !== "oc_certificate" || !certLotId) return;
    let cancelled = false;
    setPrefilling(true);
    getOCCertificateData(ocId, certLotId, certApplicant || "", certEmail || "")
      .then((data) => {
        if (cancelled || !data) return;
        setCertCurrentFees(data.currentFees);
        setCertBillingCycle(data.billingCycle);
        setCertFeesPaidUpTo(data.feesPaidUpTo);
        setCertUnpaidFees(Number(data.unpaidFeesTotal).toFixed(2));
        setCertLastAgm(data.lastAgmDate ? new Date(data.lastAgmDate) : undefined);
      })
      .finally(() => { if (!cancelled) setPrefilling(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [certLotId, reportType, ocId]);

  const availableReports = REPORTS.filter((r) => !r.managerOnly || !isLotOwner);

  // Proxy logo through API to avoid CORS, convert to data URL for react-pdf
  async function getLogoDataUrl(): Promise<string | null> {
    if (!logoUrl) return null;
    try {
      const res = await fetch(`/api/proxy-image?url=${encodeURIComponent(logoUrl)}`);
      if (!res.ok) {
        console.error(`Logo proxy failed (${res.status}) for ${logoUrl}`);
        return null;
      }
      const blob = await res.blob();
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.readAsDataURL(blob);
      });
    } catch (err) {
      console.error("Logo proxy failed", err);
      return null;
    }
  }

  async function handleGenerate() {
    if (!reportType) return;

    setGenerating(true);
    setPdfUrl(null);
    setCsvBlobUrl(null);

    try {
      const subName = `${ocName} · ${ocPlanNumber}`;
      const subAddr = ocAddress;
      const logoDataUrl = await getLogoDataUrl();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let element: any;
      // PP7-B: holds CSV string for the 3 new reports; converted to a blob
      // URL after the switch.
      let csvString: string | null = null;

      switch (reportType) {
        case "levy_history": {
          const data = await getLevyHistory(ocId, selectedLotId || undefined);
          const selectedLot = selectedLotId ? lots.find((l) => l.id === selectedLotId) : null;
          const lotOwnerName = selectedLot?.owner_display_name ?? undefined;
          element = createElement(LevyHistoryReport, { data, title: "Levy History Report", subtitle: subName, address: subAddr, logoUrl: logoDataUrl, lotOwnerName });
          break;
        }
        case "insurance_status": {
          const data = await getInsuranceStatus(ocId);
          element = createElement(InsuranceStatusReport, { data, title: "Insurance Status Report", subtitle: subName, address: subAddr, logoUrl: logoDataUrl });
          break;
        }
        case "lot_register": {
          const data = await getLotOwnerRegister(ocId);
          element = createElement(LotRegisterReport, { data, title: "Lot Owner Register", subtitle: subName, address: subAddr, logoUrl: logoDataUrl, showContact: !isLotOwner });
          break;
        }
        case "communication_log": {
          const data = await getCommunicationLog(ocId);
          element = createElement(CommLogReport, { data, title: "Communication Log Report", subtitle: subName, address: subAddr, logoUrl: logoDataUrl });
          break;
        }
        case "audit_trail": {
          const data = await getAuditTrail(ocId);
          element = createElement(AuditTrailReport, { data, title: "Audit Trail Report", subtitle: subName, address: subAddr, logoUrl: logoDataUrl });
          break;
        }
        case "oc_certificate": {
          if (!certLotId || !certApplicant || !certEmail) {
            toast.error("Please fill in all certificate fields");
            setGenerating(false);
            return;
          }
          const certData = await getOCCertificateData(ocId, certLotId, certApplicant, certEmail);
          if (!certData) { toast.error("Failed to load certificate data"); setGenerating(false); return; }
          // Override with form values
          certData.applicationDate = format(certAppDate, "yyyy-MM-dd");
          certData.currentFees = certCurrentFees;
          certData.billingCycle = certBillingCycle;
          certData.feesPaidUpTo = certFeesPaidUpTo;
          certData.unpaidFeesTotal = Number(certUnpaidFees) || 0;
          certData.repairsInfo = certRepairs;
          certData.totalFundsHeld = certFunds;
          certData.liabilities = certLiabilities;
          certData.currentContracts = certContracts;
          certData.serviceAgreements = certServices;
          certData.noticesOrders = certNotices;
          certData.legalProceedings = certLegal;
          certData.lastAgmDate = certLastAgm ? format(certLastAgm, "yyyy-MM-dd") : "";
          // Proxy logo and signature for client-side PDF
          const certLogo = certData.logoUrl ? await getLogoDataUrl() : null;
          let certSig: string | null = null;
          if (certData.signatureUrl) {
            try {
              const sigRes = await fetch(`/api/proxy-image?url=${encodeURIComponent(certData.signatureUrl)}`);
              if (sigRes.ok) {
                const sigBlob = await sigRes.blob();
                certSig = await new Promise((r) => { const rd = new FileReader(); rd.onloadend = () => r(rd.result as string); rd.readAsDataURL(sigBlob); });
              } else {
                console.error(`Signature proxy failed (${sigRes.status}) for ${certData.signatureUrl}`);
              }
            } catch (err) {
              console.error("Signature proxy failed", err);
            }
          }
          element = createElement(OCCertificate, { ...certData, logoUrl: certLogo, signatureUrl: certSig });
          break;
        }
        case "outstanding_arrears": {
          const data = await getOutstandingArrearsReport(ocId, asOfDate);
          element = createElement(OutstandingArrearsReport, {
            data,
            title: "Outstanding Arrears Report",
            subtitle: subName,
            address: subAddr,
            logoUrl: logoDataUrl,
            asOfDate,
          });
          csvString = outstandingArrearsToCsv(data);
          break;
        }
        case "owner_statement": {
          if (!selectedLotId) { toast.error("Select a lot"); setGenerating(false); return; }
          const report = await getOwnerStatement(ocId, selectedLotId, rangeFrom, rangeTo);
          element = createElement(OwnerStatementReportPdf, {
            report,
            title: "Owner Statement",
            subtitle: subName,
            address: subAddr,
            logoUrl: logoDataUrl,
          });
          csvString = ownerStatementToCsv(report);
          break;
        }
        case "trust_account_summary": {
          const data = await getTrustAccountSummary(ocId, rangeFrom, rangeTo);
          element = createElement(TrustAccountSummaryReport, {
            data,
            title: "Trust Account Summary",
            subtitle: subName,
            address: subAddr,
            logoUrl: logoDataUrl,
            fromDate: rangeFrom,
            toDate: rangeTo,
          });
          csvString = trustAccountSummaryToCsv(data);
          break;
        }
      }

      const blob = await pdf(element).toBlob();
      const url = URL.createObjectURL(blob);
      setPdfUrl(url);

      if (csvString) {
        const csvBlob = new Blob([csvString], { type: "text/csv;charset=utf-8" });
        setCsvBlobUrl(URL.createObjectURL(csvBlob));
      }
    } catch (err) {
      console.error("Failed to generate report:", err);
      toast.error(`Failed to generate report: ${err instanceof Error ? err.message : String(err)}`);
    }

    setGenerating(false);
  }

  function handleDownload() {
    if (!pdfUrl || !reportType) return;
    const a = document.createElement("a");
    a.href = pdfUrl;
    const reportNames: Record<string, string> = {
      oc_certificate: "OC-Certificate",
      levy_history: "Levy-History-Report",
      insurance_status: "Insurance-Status-Report",
      lot_register: "Lot-Owner-Register",
      communication_log: "Communication-Log",
      audit_trail: "Audit-Trail",
      outstanding_arrears: "Outstanding-Arrears",
      owner_statement: "Owner-Statement",
      trust_account_summary: "Trust-Account-Summary",
    };
    const dateStr = new Date().toISOString().split("T")[0];
    const subSlug = ocName.replace(/\s+/g, "-");
    a.download = `${reportNames[reportType] ?? reportType}-${subSlug}-${dateStr}.pdf`;
    a.click();
  }

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-foreground">Reports</h1>

      {/* Controls */}
      <Card>
        <CardContent className="pt-5">
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1.5 flex-1 min-w-[200px]">
              <Label>Report type</Label>
              <select
                value={reportType}
                onChange={(e) => { setReportType(e.target.value as ReportType); setPdfUrl(null); }}
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              >
                <option value="">Select a report...</option>
                {availableReports.map((r) => (
                  <option key={r.id} value={r.id}>{r.label}</option>
                ))}
              </select>
            </div>

            {/* Lot filter for levy history (managers only) */}
            {reportType === "levy_history" && !isLotOwner && (
              <div className="space-y-1.5 min-w-[200px]">
                <Label>Lot owner</Label>
                <select
                  value={selectedLotId}
                  onChange={(e) => setSelectedLotId(e.target.value)}
                  className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                >
                  <option value="">All lots</option>
                  {lots.map((lot) => (
                    <option key={lot.id} value={lot.id}>
                      Lot {lot.lot_number}{lot.owner_display_name ? ` , ${lot.owner_display_name}` : ""}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* PP7-B: As-of date for Outstanding arrears */}
            {reportType === "outstanding_arrears" && (
              <div className="space-y-1.5 min-w-[180px]">
                <Label>As of</Label>
                <DatePicker value={asOfDate} onChange={setAsOfDate} />
              </div>
            )}

            {/* PP7-B: Lot + date range for Owner statement */}
            {reportType === "owner_statement" && (
              <>
                <div className="space-y-1.5 min-w-[200px]">
                  <Label>Lot</Label>
                  <select
                    value={selectedLotId}
                    onChange={(e) => setSelectedLotId(e.target.value)}
                    className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                  >
                    <option value="">Select lot...</option>
                    {lots.map((lot) => (
                      <option key={lot.id} value={lot.id}>
                        Lot {lot.lot_number}{lot.owner_display_name ? ` , ${lot.owner_display_name}` : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5 min-w-[160px]">
                  <Label>From</Label>
                  <DatePicker value={rangeFrom} onChange={setRangeFrom} />
                </div>
                <div className="space-y-1.5 min-w-[160px]">
                  <Label>To</Label>
                  <DatePicker value={rangeTo} onChange={setRangeTo} />
                </div>
              </>
            )}

            {/* PP7-B: Date range for Trust account summary */}
            {reportType === "trust_account_summary" && (
              <>
                <div className="space-y-1.5 min-w-[160px]">
                  <Label>From</Label>
                  <DatePicker value={rangeFrom} onChange={setRangeFrom} />
                </div>
                <div className="space-y-1.5 min-w-[160px]">
                  <Label>To</Label>
                  <DatePicker value={rangeTo} onChange={setRangeTo} />
                </div>
              </>
            )}

            {/* OC Certificate fields */}
            {reportType === "oc_certificate" && (
              <>
                <div className="space-y-1.5 min-w-[200px]">
                  <Label>Lot</Label>
                  <select
                    value={certLotId}
                    onChange={(e) => setCertLotId(e.target.value)}
                    className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                  >
                    <option value="">Select lot...</option>
                    {lots.map((lot) => (
                      <option key={lot.id} value={lot.id}>
                        Lot {lot.lot_number}{lot.owner_display_name ? ` , ${lot.owner_display_name}` : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5 min-w-[180px]">
                  <Label>Applicant name</Label>
                  <Input value={certApplicant} onChange={(e) => setCertApplicant(e.target.value)} placeholder="Applicant name" className="h-9" />
                </div>
                <div className="space-y-1.5 min-w-[180px]">
                  <Label>Delivery email</Label>
                  <Input value={certEmail} onChange={(e) => setCertEmail(e.target.value)} placeholder="email@example.com" className="h-9" />
                </div>
                <div className="space-y-1.5 min-w-[150px]">
                  <Label>Application received</Label>
                  <Popover open={certAppDateOpen} onOpenChange={setCertAppDateOpen}>
                    <PopoverTrigger className="flex h-9 w-full items-center gap-2 rounded-md border border-border bg-background px-3 text-sm cursor-pointer">
                      <CalendarIcon className="h-3.5 w-3.5 text-muted-foreground" />
                      {format(certAppDate, "d MMM yyyy")}
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-2" align="start">
                      <Calendar mode="single" selected={certAppDate} onSelect={(d) => { if (d) setCertAppDate(d); setCertAppDateOpen(false); }} />
                    </PopoverContent>
                  </Popover>
                </div>
              </>
            )}

            {/* OC Certificate detail fields */}
            {reportType === "oc_certificate" && certLotId && (
              <div className="w-full border-t border-border pt-4 mt-2 grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">1. Current fees{prefilling ? " (loading…)" : ""}</Label>
                  <Input value={certCurrentFees} onChange={(e) => setCertCurrentFees(e.target.value)} placeholder="$0.00" className="h-8 text-sm" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Billing cycle</Label>
                  <select
                    value={certBillingCycle}
                    onChange={(e) => setCertBillingCycle(e.target.value)}
                    className="h-8 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                  >
                    <option value="monthly">monthly</option>
                    <option value="quarterly">quarterly</option>
                    <option value="half_yearly">half-yearly</option>
                    <option value="annually">annually</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">2. Fees paid up to</Label>
                  <Input value={certFeesPaidUpTo} onChange={(e) => setCertFeesPaidUpTo(e.target.value)} placeholder="YYYY-MM-DD or n/a" className="h-8 text-sm" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">3. Unpaid fees total ($)</Label>
                  <Input value={certUnpaidFees} onChange={(e) => setCertUnpaidFees(e.target.value)} placeholder="0.00" className="h-8 text-sm" inputMode="decimal" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">5. Repairs / maintenance</Label>
                  <Input value={certRepairs} onChange={(e) => setCertRepairs(e.target.value)} className="h-8 text-sm" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">8. Total funds held</Label>
                  <div className="flex h-8 w-full overflow-hidden rounded-md border border-border bg-card text-sm transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
                    <div className="flex items-center border-r border-border bg-cool-muted px-2.5 text-sm font-medium text-cool-muted-foreground select-none">$</div>
                    <input value={certFunds} onChange={(e) => setCertFunds(e.target.value)} placeholder="Total funds held" className="flex-1 min-w-0 bg-transparent px-3 outline-none placeholder:text-muted-foreground" />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">9. Liabilities</Label>
                  <Input value={certLiabilities} onChange={(e) => setCertLiabilities(e.target.value)} placeholder="e.g. Nil" className="h-8 text-sm" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">10. Contracts / leases</Label>
                  <Input value={certContracts} onChange={(e) => setCertContracts(e.target.value)} placeholder="e.g. Cleaning contract..." className="h-8 text-sm" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">11. Service agreements</Label>
                  <Input value={certServices} onChange={(e) => setCertServices(e.target.value)} className="h-8 text-sm" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">12. Notices / orders (12 months)</Label>
                  <Input value={certNotices} onChange={(e) => setCertNotices(e.target.value)} className="h-8 text-sm" />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label className="text-xs">13. Legal proceedings</Label>
                  <Input value={certLegal} onChange={(e) => setCertLegal(e.target.value)} className="h-8 text-sm" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">16. Last AGM date</Label>
                  <Popover open={certLastAgmOpen} onOpenChange={setCertLastAgmOpen}>
                    <PopoverTrigger className="flex h-8 w-full items-center gap-2 rounded-md border border-border bg-background px-3 text-sm cursor-pointer">
                      <CalendarIcon className="h-3.5 w-3.5 text-muted-foreground" />
                      {certLastAgm ? format(certLastAgm, "d MMM yyyy") : <span className="text-muted-foreground">Select date or leave blank</span>}
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-2" align="start">
                      <Calendar mode="single" selected={certLastAgm} onSelect={(d) => { setCertLastAgm(d); setCertLastAgmOpen(false); }} />
                      {certLastAgm && (
                        <div className="border-t border-border pt-2 mt-2">
                          <button
                            type="button"
                            onClick={() => { setCertLastAgm(undefined); setCertLastAgmOpen(false); }}
                            className="w-full text-xs text-muted-foreground hover:text-foreground cursor-pointer"
                          >
                            Clear date
                          </button>
                        </div>
                      )}
                    </PopoverContent>
                  </Popover>
                </div>
              </div>
            )}

            <Button
              onClick={handleGenerate}
              disabled={!reportType || generating}
              className="cursor-pointer"
            >
              {generating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Generating...
                </>
              ) : (
                "Generate report"
              )}
            </Button>

            {pdfUrl && (
              <Button variant="outline" onClick={handleDownload} className="cursor-pointer">
                <Download className="mr-2 h-4 w-4" />
                Download PDF
              </Button>
            )}

            {csvBlobUrl && (
              <Button
                variant="outline"
                onClick={() => {
                  const a = document.createElement("a");
                  a.href = csvBlobUrl;
                  const reportNames: Record<string, string> = {
                    outstanding_arrears: "Outstanding-Arrears",
                    owner_statement: "Owner-Statement",
                    trust_account_summary: "Trust-Account-Summary",
                  };
                  const dateStr = new Date().toISOString().split("T")[0];
                  const subSlug = ocName.replace(/\s+/g, "-");
                  a.download = `${reportNames[reportType] ?? reportType}-${subSlug}-${dateStr}.csv`;
                  a.click();
                }}
                className="cursor-pointer"
              >
                <Download className="mr-2 h-4 w-4" />
                Download CSV
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* PDF Preview */}
      {pdfUrl && (
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <iframe
              src={pdfUrl}
              className="w-full border-none"
              style={{ height: "80vh" }}
              title="Report preview"
            />
          </CardContent>
        </Card>
      )}

      {/* Empty state */}
      {!pdfUrl && !generating && (
        <Card>
          <CardContent className="flex items-center justify-center py-16">
            <p className="text-sm text-muted-foreground">Select a report type and click generate to preview.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
