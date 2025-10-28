import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FileText, Download, Scale, ArrowLeft, Save } from "lucide-react";
import TemplateUpload from "@/components/TemplateUpload";
import PlaceholderInputs from "@/components/PlaceholderInputs";
import DeedsTable, { Deed } from "@/components/DeedsTable";
import DocumentDetailsTable, { DocumentDetail } from "@/components/DocumentDetailsTable";
import ReportPreview from "@/components/ReportPreview";
import { toast } from "sonner";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { saveAs } from "file-saver";
import { supabase } from "@/integrations/supabase/client";
const Index = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [templateFile, setTemplateFile] = useState<File | null>(null);
  const [templateContent, setTemplateContent] = useState<string>("");
  const [placeholders, setPlaceholders] = useState<Record<string, string>>({});
  const [deeds, setDeeds] = useState<Deed[]>([]);
  const [documents, setDocuments] = useState<DocumentDetail[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [templateId, setTemplateId] = useState<string | null>(null);
  useEffect(() => {
    loadDeeds();
    setupRealtimeSubscription();

    // Load template if coming from Templates page
    const state = location.state as {
      templateId?: string;
      templateName?: string;
    } | null;
    if (state?.templateId) {
      setTemplateId(state.templateId);
      loadTemplateFromDatabase(state.templateId, state.templateName);
    } else {
      // Redirect to templates page if no template is loaded
      navigate("/templates");
    }
  }, []);
  const loadDeeds = async () => {
    const {
      data,
      error
    } = await supabase.from("deeds").select("*").order("created_at", {
      ascending: true
    });
    if (error) {
      console.error("Error loading deeds:", error);
      return;
    }
    setDeeds(data || []);
  };
  const loadTemplateFromDatabase = async (templateId: string, name?: string) => {
    try {
      const {
        data,
        error
      } = await supabase.from("document_templates").select("file_data, file_name, template_name").eq("id", templateId).single();
      if (error) throw error;

      // Convert hex string back to File
      const hexString = data.file_data.startsWith('\\x') ? data.file_data.slice(2) : data.file_data;
      const bytes = new Uint8Array(hexString.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
      const blob = new Blob([bytes], {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      });
      const file = new File([blob], data.file_name, {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      });
      setTemplateName(name || data.template_name);
      await handleTemplateUpload(file);
      toast.success(`Template "${name || data.template_name}" loaded successfully`);
    } catch (error) {
      console.error("Error loading template:", error);
      toast.error("Failed to load template");
    }
  };
  const setupRealtimeSubscription = () => {
    const channel = supabase.channel("deeds-changes-index").on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "deeds"
    }, payload => {
      if (payload.eventType === "INSERT") {
        setDeeds(prev => [...prev, payload.new as Deed]);
      } else if (payload.eventType === "UPDATE") {
        setDeeds(prev => prev.map(deed => deed.id === payload.new.id ? payload.new as Deed : deed));
      } else if (payload.eventType === "DELETE") {
        setDeeds(prev => prev.filter(deed => deed.id !== payload.old.id));
      }
    }).subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  };
  const handleTemplateUpload = async (file: File) => {
    try {
      console.log("Starting to parse file:", file.name, "Size:", file.size, "Type:", file.type);
      const arrayBuffer = await file.arrayBuffer();
      const zip = new PizZip(arrayBuffer);

      // Read Word XML directly to avoid Docxtemplater compile errors during upload
      const docFile = zip.file("word/document.xml");
      if (!docFile) throw new Error("Invalid .docx: missing word/document.xml");
      let xml = docFile.asText();

      // Merge adjacent text runs to fix split placeholders BEFORE extracting text
      xml = xml.replace(/<\/w:t><\/w:r><w:r[^>]*><w:t[^>]*>/g, '');
      xml = xml.replace(/<\/w:t><\/w:r><w:r><w:t>/g, '');

      // Extract human-readable text for placeholder detection
      let text = xml.replace(/<w:p[^>]*>/g, "\n") // new paragraph -> newline
      .replace(/<[^>]+>/g, "") // strip all XML tags
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
      setTemplateContent(text);
      setTemplateFile(file);

      // Extract placeholders - single braces {key} for fields, double braces {{table}} for the deeds table
      const singleBraceRegex = /\{([^{}]+)\}/g;
      const doubleTableRegex = /\{\{table\}\}/i;
      const doubleTable1Regex = /\{\{table1\}\}/i;
      const detectedPlaceholders: Record<string, string> = {};

      // Exclude auto-generated table-related fields and history field
      const tableRelatedFields = ["sno", "date", "deed", "deedinfo", "deeds", "table", "table1", "$history", "history"];

      // Extract single-brace placeholders (regular fields) — allow spaces
      const singleMatches = text.matchAll(singleBraceRegex);
      for (const match of singleMatches) {
        const raw = match[1].trim();
        const key = raw;
        // Skip control tags like {#items} or {/items} and table placeholders and history placeholder
        if (/^[#/^$]/.test(key) || key.toLowerCase() === "table" || key.toLowerCase() === "table1" || key.toLowerCase() === "history") continue;
        if (!detectedPlaceholders[key] && !tableRelatedFields.includes(key.toLowerCase())) {
          detectedPlaceholders[key] = "";
        }
      }

      // Warn about unsupported control tags like {#items}/{/items}
      const unsupported = text.match(/\{[#/^].+?\}/g);
      if (unsupported?.length) {
        console.warn("Unsupported control tags detected:", unsupported);
        toast.warning("Template uses unsupported loop/control tags. Use {{table}} for the deeds table.");
      }
      const hasTablePlaceholder = doubleTableRegex.test(text);
      const hasTable1Placeholder = doubleTable1Regex.test(text);
      const hasHistoryPlaceholder = /\{\$history\}/i.test(text);
      console.log("Detected placeholders:", Object.keys(detectedPlaceholders));
      setPlaceholders(detectedPlaceholders);
      toast.success(`Template parsed! Found ${Object.keys(detectedPlaceholders).length} field(s)${hasTablePlaceholder ? ' and {{table}} placeholder' : ''}${hasTable1Placeholder ? ' and {{table1}} placeholder' : ''}${hasHistoryPlaceholder ? ' and {$history} placeholder' : ''}`);
    } catch (error: any) {
      console.error("Upload parse error:", error);
      const errors = error?.properties?.errors;
      if (Array.isArray(errors)) {
        errors.forEach((e: any, i: number) => console.error(`Template error ${i + 1}:`, e?.properties || e));
      }
      let errorMessage = "Failed to parse Word template. ";
      errorMessage += error?.message || "Unknown error";
      toast.error(errorMessage);
    }
  };
  const handlePlaceholderChange = (key: string, value: string) => {
    setPlaceholders(prev => ({
      ...prev,
      [key]: value
    }));
  };
  const generateHistoryOfTitle = async (validDeeds: Deed[]): Promise<string> => {
    if (validDeeds.length === 0) return "";
    const historyParts: string[] = [];
    for (const deed of validDeeds) {
      if (!deed.deed_type) continue;

      // Fetch the history template for this deed type
      const {
        data,
        error
      } = await supabase.from("history_of_title_templates").select("template_content").eq("deed_type", deed.deed_type).maybeSingle();
      if (error) {
        console.error("Error fetching history template:", error);
        continue;
      }
      if (data?.template_content) {
        // Replace placeholders in the history template
        let historyText = data.template_content.replace(/{executedBy}/g, deed.executed_by || "").replace(/{inFavourOf}/g, deed.in_favour_of || "").replace(/{date}/g, deed.date || "").replace(/{documentNumber}/g, deed.document_number || "").replace(/{deedType}/g, deed.deed_type || "").replace(/{natureOfDoc}/g, deed.nature_of_doc || "");

        // Replace custom field placeholders
        if (deed.custom_fields && typeof deed.custom_fields === 'object') {
          Object.entries(deed.custom_fields).forEach(([key, value]) => {
            const regex = new RegExp(`\\{${key}\\}`, 'gi');
            historyText = historyText.replace(regex, String(value || ""));
          });
        }
        historyParts.push(historyText);
      }
    }
    return historyParts.join("\n\n");
  };
  const handleDownload = async () => {
    if (!templateFile) {
      toast.error("Please upload a template first");
      return;
    }
    try {
      const arrayBuffer = await templateFile.arrayBuffer();
      const zip = new PizZip(arrayBuffer);

      // Fix split placeholders in Word XML
      const docXmlFile = zip.file("word/document.xml");
      if (!docXmlFile) {
        throw new Error("Invalid Word document structure");
      }
      let xml = docXmlFile.asText();

      // Merge adjacent text runs to fix split placeholders
      xml = xml.replace(/<\/w:t><\/w:r><w:r[^>]*><w:t[^>]*>/g, '');
      xml = xml.replace(/<\/w:t><\/w:r><w:r><w:t>/g, '');

      // Normalize {{table}} to {table} and {{table1}} to {table1}
      xml = xml.replace(/\{\{table\}\}/gi, "{table}");
      xml = xml.replace(/\{\{table1\}\}/gi, "{table1}");

      // Replace {table} placeholder with actual Word table XML BEFORE Docxtemplater processes it
      const validDeeds = deeds.filter(deed => deed.deed_type && deed.executed_by && deed.in_favour_of);
      if (validDeeds.length > 0) {
        const tableXml = generateWordTableXml(validDeeds);
        // Close the paragraph before table, insert table, open new paragraph after
        xml = xml.replace(/\{table\}/gi, '</w:t></w:r></w:p>' + tableXml + '<w:p><w:r><w:t>');
      } else {
        // Replace with simple text if no deeds
        xml = xml.replace(/\{table\}/gi, 'No deeds added yet');
      }

      // Replace {table1} placeholder with document details Word table XML
      if (documents.length > 0) {
        const docTableXml = generateDocumentDetailsWordTableXml(documents);
        xml = xml.replace(/\{table1\}/gi, '</w:t></w:r></w:p>' + docTableXml + '<w:p><w:r><w:t>');
      } else {
        xml = xml.replace(/\{table1\}/gi, 'No document details added yet');
      }

      // Generate and replace {$history} placeholder
      const historyContent = await generateHistoryOfTitle(validDeeds);
      if (historyContent) {
        // Split history content into lines and create proper Word XML paragraphs with Cambria 12pt
        const lines = historyContent.split('\n');
        const historyXml = lines.map(line => {
          const escapedLine = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
          return `<w:p><w:r><w:rPr><w:rFonts w:ascii="Cambria" w:hAnsi="Cambria"/><w:sz w:val="24"/></w:rPr><w:t>${escapedLine}</w:t></w:r></w:p>`;
        }).join('');

        // Replace {$history} - close current paragraph, insert history paragraphs, open new paragraph
        xml = xml.replace(/\{\$history\}/gi, `</w:t></w:r></w:p>${historyXml}<w:p><w:r><w:t>`);
      } else {
        xml = xml.replace(/\{\$history\}/gi, '');
      }

      // Update the XML in the zip
      zip.file("word/document.xml", xml);
      const doc = new Docxtemplater(zip, {
        paragraphLoop: true,
        linebreaks: true,
        nullGetter: () => ""
      });

      // Prepare data for replacement (only regular placeholders now, table is already replaced)
      const data: Record<string, any> = {
        ...placeholders
      };
      doc.render(data);
      const output = doc.getZip().generate({
        type: "blob",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      });
      saveAs(output, "Legal_Scrutiny_Report.docx");
      toast.success("Document downloaded successfully");
    } catch (error) {
      console.error("Error generating document:", error);
      toast.error("Failed to generate document");
    }
  };

  const handleSaveAsDraft = async () => {
    if (!templateId) {
      toast.error("No template loaded");
      return;
    }

    try {
      const draftName = `Draft - ${templateName} - ${new Date().toLocaleDateString()}`;
      
      const { data, error } = await supabase
        .from("drafts")
        .insert({
          template_id: templateId,
          draft_name: draftName,
          placeholders: placeholders,
          documents: documents,
        })
        .select()
        .single();

      if (error) throw error;

      toast.success("Draft saved successfully");
    } catch (error) {
      console.error("Error saving draft:", error);
      toast.error("Failed to save draft");
    }
  };

  const escapeXml = (text: string): string => {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  };
  const generateWordTableXml = (validDeeds: Deed[]) => {
    let tableRows = '';
    validDeeds.forEach((deed, index) => {
      const sno = escapeXml((index + 1).toString());
      const date = escapeXml(deed.date || '-');
      const docNo = escapeXml(deed.document_number || '-');
      const deedInfo = escapeXml(`${deed.deed_type} executed by ${deed.executed_by} in favour of ${deed.in_favour_of}`);
      const nature = escapeXml(deed.nature_of_doc || '-');
      tableRows += `
        <w:tr>
          <w:tc>
            <w:tcPr><w:tcW w:w="600" w:type="dxa"/></w:tcPr>
            <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>${sno}</w:t></w:r></w:p>
          </w:tc>
          <w:tc>
            <w:tcPr><w:tcW w:w="1400" w:type="dxa"/></w:tcPr>
            <w:p><w:r><w:t>${date}</w:t></w:r></w:p>
          </w:tc>
          <w:tc>
            <w:tcPr><w:tcW w:w="1400" w:type="dxa"/></w:tcPr>
            <w:p><w:r><w:t>${docNo}</w:t></w:r></w:p>
          </w:tc>
          <w:tc>
            <w:tcPr><w:tcW w:w="4400" w:type="dxa"/></w:tcPr>
            <w:p><w:r><w:t>${deedInfo}</w:t></w:r></w:p>
          </w:tc>
          <w:tc>
            <w:tcPr><w:tcW w:w="1200" w:type="dxa"/></w:tcPr>
            <w:p><w:r><w:t>${nature}</w:t></w:r></w:p>
          </w:tc>
        </w:tr>`;
    });
    return `<w:tbl>
        <w:tblPr>
          <w:tblW w:w="9000" w:type="dxa"/>
          <w:tblBorders>
            <w:top w:val="single" w:sz="8" w:space="0" w:color="000000"/>
            <w:left w:val="single" w:sz="8" w:space="0" w:color="000000"/>
            <w:bottom w:val="single" w:sz="8" w:space="0" w:color="000000"/>
            <w:right w:val="single" w:sz="8" w:space="0" w:color="000000"/>
            <w:insideH w:val="single" w:sz="8" w:space="0" w:color="000000"/>
            <w:insideV w:val="single" w:sz="8" w:space="0" w:color="000000"/>
          </w:tblBorders>
        </w:tblPr>
        <w:tblGrid>
          <w:gridCol w:w="600"/>
          <w:gridCol w:w="1400"/>
          <w:gridCol w:w="1400"/>
          <w:gridCol w:w="4400"/>
          <w:gridCol w:w="1200"/>
        </w:tblGrid>
        <w:tr>
          <w:tc>
            <w:tcPr><w:tcW w:w="600" w:type="dxa"/></w:tcPr>
            <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Sno</w:t></w:r></w:p>
          </w:tc>
          <w:tc>
            <w:tcPr><w:tcW w:w="1400" w:type="dxa"/></w:tcPr>
            <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Date</w:t></w:r></w:p>
          </w:tc>
          <w:tc>
            <w:tcPr><w:tcW w:w="1400" w:type="dxa"/></w:tcPr>
            <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>D.No</w:t></w:r></w:p>
          </w:tc>
          <w:tc>
            <w:tcPr><w:tcW w:w="4400" w:type="dxa"/></w:tcPr>
            <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Particulars of Deed</w:t></w:r></w:p>
          </w:tc>
          <w:tc>
            <w:tcPr><w:tcW w:w="1200" w:type="dxa"/></w:tcPr>
            <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Nature of Doc</w:t></w:r></w:p>
          </w:tc>
        </w:tr>${tableRows}</w:tbl>`;
  };

  const generateDocumentDetailsWordTableXml = (docs: DocumentDetail[]) => {
    let allTablesXml = '';
    
    docs.forEach((doc, docIndex) => {
      // Add spacing between documents
      if (docIndex > 0) {
        allTablesXml += '<w:p><w:r><w:t></w:t></w:r></w:p>';
      }

      // Add heading
      allTablesXml += `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>As per Doc No : ${escapeXml(doc.docNo || '(As per Doc No)')}</w:t></w:r></w:p>`;

      // Main details table - 3 columns structure
      const mainTableXml = `<w:tbl>
        <w:tblPr>
          <w:tblW w:w="9000" w:type="dxa"/>
          <w:tblBorders>
            <w:top w:val="single" w:sz="8" w:space="0" w:color="000000"/>
            <w:left w:val="single" w:sz="8" w:space="0" w:color="000000"/>
            <w:bottom w:val="single" w:sz="8" w:space="0" w:color="000000"/>
            <w:right w:val="single" w:sz="8" w:space="0" w:color="000000"/>
            <w:insideH w:val="single" w:sz="8" w:space="0" w:color="000000"/>
            <w:insideV w:val="single" w:sz="8" w:space="0" w:color="000000"/>
          </w:tblBorders>
        </w:tblPr>
        <w:tblGrid>
          <w:gridCol w:w="600"/>
          <w:gridCol w:w="4200"/>
          <w:gridCol w:w="4200"/>
        </w:tblGrid>
        <w:tr>
          <w:tc><w:tcPr>
            <w:tcW w:w="600" w:type="dxa"/>
            <w:tcMar>
              <w:top w:w="400" w:type="dxa"/>
              <w:left w:w="300" w:type="dxa"/>
              <w:bottom w:w="400" w:type="dxa"/>
              <w:right w:w="300" w:type="dxa"/>
            </w:tcMar>
          </w:tcPr>
            <w:p><w:r><w:t>i</w:t></w:r></w:p>
          </w:tc>
          <w:tc><w:tcPr>
            <w:tcW w:w="4200" w:type="dxa"/>
            <w:tcMar>
              <w:top w:w="400" w:type="dxa"/>
              <w:left w:w="300" w:type="dxa"/>
              <w:bottom w:w="400" w:type="dxa"/>
              <w:right w:w="300" w:type="dxa"/>
            </w:tcMar>
          </w:tcPr>
            <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Survey No</w:t></w:r></w:p>
          </w:tc>
          <w:tc><w:tcPr>
            <w:tcW w:w="4200" w:type="dxa"/>
            <w:tcMar>
              <w:top w:w="400" w:type="dxa"/>
              <w:left w:w="300" w:type="dxa"/>
              <w:bottom w:w="400" w:type="dxa"/>
              <w:right w:w="300" w:type="dxa"/>
            </w:tcMar>
          </w:tcPr>
            <w:p><w:r><w:t>${escapeXml(doc.surveyNo || '(Survey No)')}</w:t></w:r></w:p>
          </w:tc>
        </w:tr>
        <w:tr>
          <w:tc><w:tcPr>
            <w:tcMar>
              <w:top w:w="400" w:type="dxa"/>
              <w:left w:w="300" w:type="dxa"/>
              <w:bottom w:w="400" w:type="dxa"/>
              <w:right w:w="300" w:type="dxa"/>
            </w:tcMar>
          </w:tcPr>
            <w:p><w:r><w:t>ii</w:t></w:r></w:p>
          </w:tc>
          <w:tc><w:tcPr>
            <w:tcMar>
              <w:top w:w="400" w:type="dxa"/>
              <w:left w:w="300" w:type="dxa"/>
              <w:bottom w:w="400" w:type="dxa"/>
              <w:right w:w="300" w:type="dxa"/>
            </w:tcMar>
          </w:tcPr>
            <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>As per Revenue Record</w:t></w:r></w:p>
          </w:tc>
          <w:tc><w:tcPr>
            <w:tcMar>
              <w:top w:w="400" w:type="dxa"/>
              <w:left w:w="300" w:type="dxa"/>
              <w:bottom w:w="400" w:type="dxa"/>
              <w:right w:w="300" w:type="dxa"/>
            </w:tcMar>
          </w:tcPr>
            <w:p><w:r><w:t>${escapeXml(doc.asPerRevenueRecord || '(As per Revenue Record)')}</w:t></w:r></w:p>
          </w:tc>
        </w:tr>
        <w:tr>
          <w:tc><w:tcPr>
            <w:tcMar>
              <w:top w:w="400" w:type="dxa"/>
              <w:left w:w="300" w:type="dxa"/>
              <w:bottom w:w="400" w:type="dxa"/>
              <w:right w:w="300" w:type="dxa"/>
            </w:tcMar>
          </w:tcPr>
            <w:p><w:r><w:t>iii</w:t></w:r></w:p>
          </w:tc>
          <w:tc><w:tcPr>
            <w:tcMar>
              <w:top w:w="400" w:type="dxa"/>
              <w:left w:w="300" w:type="dxa"/>
              <w:bottom w:w="400" w:type="dxa"/>
              <w:right w:w="300" w:type="dxa"/>
            </w:tcMar>
          </w:tcPr>
            <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Total Extent</w:t></w:r></w:p>
          </w:tc>
          <w:tc><w:tcPr>
            <w:tcMar>
              <w:top w:w="400" w:type="dxa"/>
              <w:left w:w="300" w:type="dxa"/>
              <w:bottom w:w="400" w:type="dxa"/>
              <w:right w:w="300" w:type="dxa"/>
            </w:tcMar>
          </w:tcPr>
            <w:p><w:r><w:t>${escapeXml(doc.totalExtent || '(Total Extent)')}</w:t></w:r></w:p>
          </w:tc>
        </w:tr>
        <w:tr>
          <w:tc><w:tcPr>
            <w:tcMar>
              <w:top w:w="400" w:type="dxa"/>
              <w:left w:w="300" w:type="dxa"/>
              <w:bottom w:w="400" w:type="dxa"/>
              <w:right w:w="300" w:type="dxa"/>
            </w:tcMar>
          </w:tcPr>
            <w:p><w:r><w:t>iv</w:t></w:r></w:p>
          </w:tc>
          <w:tc><w:tcPr>
            <w:tcMar>
              <w:top w:w="400" w:type="dxa"/>
              <w:left w:w="300" w:type="dxa"/>
              <w:bottom w:w="400" w:type="dxa"/>
              <w:right w:w="300" w:type="dxa"/>
            </w:tcMar>
          </w:tcPr>
            <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Plot No</w:t></w:r></w:p>
          </w:tc>
          <w:tc><w:tcPr>
            <w:tcMar>
              <w:top w:w="400" w:type="dxa"/>
              <w:left w:w="300" w:type="dxa"/>
              <w:bottom w:w="400" w:type="dxa"/>
              <w:right w:w="300" w:type="dxa"/>
            </w:tcMar>
          </w:tcPr>
            <w:p><w:r><w:t>${escapeXml(doc.plotNo || '(Plot No)')}</w:t></w:r></w:p>
          </w:tc>
        </w:tr>
        <w:tr>
          <w:tc><w:tcPr>
            <w:tcMar>
              <w:top w:w="400" w:type="dxa"/>
              <w:left w:w="300" w:type="dxa"/>
              <w:bottom w:w="400" w:type="dxa"/>
              <w:right w:w="300" w:type="dxa"/>
            </w:tcMar>
          </w:tcPr>
            <w:p><w:r><w:t>v</w:t></w:r></w:p>
          </w:tc>
          <w:tc><w:tcPr>
            <w:tcMar>
              <w:top w:w="400" w:type="dxa"/>
              <w:left w:w="300" w:type="dxa"/>
              <w:bottom w:w="400" w:type="dxa"/>
              <w:right w:w="300" w:type="dxa"/>
            </w:tcMar>
          </w:tcPr>
            <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Location like name of the place, village, city, registration, sub-district etc.</w:t></w:r></w:p>
          </w:tc>
          <w:tc><w:tcPr>
            <w:tcMar>
              <w:top w:w="400" w:type="dxa"/>
              <w:left w:w="300" w:type="dxa"/>
              <w:bottom w:w="400" w:type="dxa"/>
              <w:right w:w="300" w:type="dxa"/>
            </w:tcMar>
          </w:tcPr>
            <w:p><w:r><w:t>${escapeXml(doc.location || '(Location like name of the place, village, city registration, sub-district etc.)')}</w:t></w:r></w:p>
          </w:tc>
        </w:tr>
        <w:tr>
          <w:tc><w:tcPr>
            <w:gridSpan w:val="3"/>
            <w:tcMar>
              <w:top w:w="400" w:type="dxa"/>
              <w:left w:w="300" w:type="dxa"/>
              <w:bottom w:w="400" w:type="dxa"/>
              <w:right w:w="300" w:type="dxa"/>
            </w:tcMar>
          </w:tcPr>
            <w:p><w:r><w:rPr><w:b/><w:u w:val="single"/></w:rPr><w:t>i) Boundaries for ${escapeXml(doc.totalExtentSqFt || '(Total Extent)')} Sq.Ft of land</w:t></w:r></w:p>
            <w:p><w:r><w:rPr><w:b/><w:u w:val="single"/></w:rPr><w:t>North By</w:t></w:r><w:r><w:t> - ${escapeXml(doc.northBy || '(North By)')}</w:t></w:r></w:p>
            <w:p><w:r><w:rPr><w:b/><w:u w:val="single"/></w:rPr><w:t>South By</w:t></w:r><w:r><w:t> - ${escapeXml(doc.southBy || '(South By)')}</w:t></w:r></w:p>
            <w:p><w:r><w:rPr><w:b/><w:u w:val="single"/></w:rPr><w:t>East By</w:t></w:r><w:r><w:t> - ${escapeXml(doc.eastBy || '(East By)')}</w:t></w:r></w:p>
            <w:p><w:r><w:rPr><w:b/><w:u w:val="single"/></w:rPr><w:t>West By</w:t></w:r><w:r><w:t> - ${escapeXml(doc.westBy || '(West By)')}</w:t></w:r></w:p>
          </w:tc>
        </w:tr>
      </w:tbl>`;

      allTablesXml += mainTableXml;

      // Add measurement details heading
      allTablesXml += '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:u w:val="single"/></w:rPr><w:t>Measurement Details</w:t></w:r></w:p>';

      // Measurement details table
      const measurementTableXml = `<w:tbl>
        <w:tblPr>
          <w:tblW w:w="9000" w:type="dxa"/>
          <w:tblBorders>
            <w:top w:val="single" w:sz="8" w:space="0" w:color="000000"/>
            <w:left w:val="single" w:sz="8" w:space="0" w:color="000000"/>
            <w:bottom w:val="single" w:sz="8" w:space="0" w:color="000000"/>
            <w:right w:val="single" w:sz="8" w:space="0" w:color="000000"/>
            <w:insideH w:val="single" w:sz="8" w:space="0" w:color="000000"/>
            <w:insideV w:val="single" w:sz="8" w:space="0" w:color="000000"/>
          </w:tblBorders>
        </w:tblPr>
        <w:tblGrid>
          <w:gridCol w:w="4500"/>
          <w:gridCol w:w="4500"/>
        </w:tblGrid>
        <w:tr>
          <w:tc><w:tcPr>
            <w:shd w:fill="D9D9D9"/>
            <w:tcMar>
              <w:top w:w="320" w:type="dxa"/>
              <w:left w:w="300" w:type="dxa"/>
              <w:bottom w:w="320" w:type="dxa"/>
              <w:right w:w="300" w:type="dxa"/>
            </w:tcMar>
          </w:tcPr>
            <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>North - East West</w:t></w:r></w:p>
          </w:tc>
          <w:tc><w:tcPr>
            <w:tcMar>
              <w:top w:w="320" w:type="dxa"/>
              <w:left w:w="300" w:type="dxa"/>
              <w:bottom w:w="320" w:type="dxa"/>
              <w:right w:w="300" w:type="dxa"/>
            </w:tcMar>
          </w:tcPr>
            <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>${escapeXml(doc.northMeasurement || '30 ft')}</w:t></w:r></w:p>
          </w:tc>
        </w:tr>
        <w:tr>
          <w:tc><w:tcPr>
            <w:shd w:fill="D9D9D9"/>
            <w:tcMar>
              <w:top w:w="320" w:type="dxa"/>
              <w:left w:w="300" w:type="dxa"/>
              <w:bottom w:w="320" w:type="dxa"/>
              <w:right w:w="300" w:type="dxa"/>
            </w:tcMar>
          </w:tcPr>
            <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>South - East West</w:t></w:r></w:p>
          </w:tc>
          <w:tc><w:tcPr>
            <w:tcMar>
              <w:top w:w="320" w:type="dxa"/>
              <w:left w:w="300" w:type="dxa"/>
              <w:bottom w:w="320" w:type="dxa"/>
              <w:right w:w="300" w:type="dxa"/>
            </w:tcMar>
          </w:tcPr>
            <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>${escapeXml(doc.southMeasurement || '30 ft')}</w:t></w:r></w:p>
          </w:tc>
        </w:tr>
        <w:tr>
          <w:tc><w:tcPr>
            <w:shd w:fill="D9D9D9"/>
            <w:tcMar>
              <w:top w:w="320" w:type="dxa"/>
              <w:left w:w="300" w:type="dxa"/>
              <w:bottom w:w="320" w:type="dxa"/>
              <w:right w:w="300" w:type="dxa"/>
            </w:tcMar>
          </w:tcPr>
            <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>East - South North</w:t></w:r></w:p>
          </w:tc>
          <w:tc><w:tcPr>
            <w:tcMar>
              <w:top w:w="320" w:type="dxa"/>
              <w:left w:w="300" w:type="dxa"/>
              <w:bottom w:w="320" w:type="dxa"/>
              <w:right w:w="300" w:type="dxa"/>
            </w:tcMar>
          </w:tcPr>
            <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>${escapeXml(doc.eastMeasurement || '40 ft')}</w:t></w:r></w:p>
          </w:tc>
        </w:tr>
        <w:tr>
          <w:tc><w:tcPr>
            <w:shd w:fill="D9D9D9"/>
            <w:tcMar>
              <w:top w:w="320" w:type="dxa"/>
              <w:left w:w="300" w:type="dxa"/>
              <w:bottom w:w="320" w:type="dxa"/>
              <w:right w:w="300" w:type="dxa"/>
            </w:tcMar>
          </w:tcPr>
            <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>West - South North</w:t></w:r></w:p>
          </w:tc>
          <w:tc><w:tcPr>
            <w:tcMar>
              <w:top w:w="320" w:type="dxa"/>
              <w:left w:w="300" w:type="dxa"/>
              <w:bottom w:w="320" w:type="dxa"/>
              <w:right w:w="300" w:type="dxa"/>
            </w:tcMar>
          </w:tcPr>
            <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>${escapeXml(doc.westMeasurement || '40 ft')}</w:t></w:r></w:p>
          </w:tc>
        </w:tr>
        <w:tr>
          <w:tc><w:tcPr>
            <w:shd w:fill="D9D9D9"/>
            <w:tcMar>
              <w:top w:w="320" w:type="dxa"/>
              <w:left w:w="300" w:type="dxa"/>
              <w:bottom w:w="320" w:type="dxa"/>
              <w:right w:w="300" w:type="dxa"/>
            </w:tcMar>
          </w:tcPr>
            <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Total</w:t></w:r></w:p>
          </w:tc>
          <w:tc><w:tcPr>
            <w:tcMar>
              <w:top w:w="320" w:type="dxa"/>
              <w:left w:w="300" w:type="dxa"/>
              <w:bottom w:w="320" w:type="dxa"/>
              <w:right w:w="300" w:type="dxa"/>
            </w:tcMar>
          </w:tcPr>
            <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>${escapeXml(doc.totalExtentSqFt || '1200 Sq.Ft')}</w:t></w:r></w:p>
          </w:tc>
        </w:tr>
      </w:tbl>`;

      allTablesXml += measurementTableXml;
    });

    return allTablesXml;
  };

  return <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="gradient-primary text-primary-foreground py-8 shadow-xl">
        <div className="container mx-auto px-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Button 
                variant="ghost" 
                size="icon"
                onClick={() => navigate("/templates")} 
                className="text-primary-foreground hover:bg-background/10"
              >
                <ArrowLeft className="h-6 w-6" />
              </Button>
              <Scale className="h-10 w-10" />
              <div>
                <h1 className="text-4xl font-bold tracking-tight">Legal Scrutiny Report Generator</h1>
                <p className="text-primary-foreground/90 mt-2">Professional Document Generation System</p>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8 space-y-8">
        {/* Introduction Card */}
        

        {/* Template Upload */}
        <TemplateUpload onTemplateUpload={handleTemplateUpload} isUploaded={!!templateFile} />

        {/* Placeholder Inputs */}
        {Object.keys(placeholders).length > 0 && <PlaceholderInputs placeholders={placeholders} onPlaceholderChange={handlePlaceholderChange} />}

        {/* Deeds Table */}
        <DeedsTable />

        {/* Document Details Table */}
        <DocumentDetailsTable documents={documents} onDocumentsChange={setDocuments} />

        {/* Report Preview */}
        {templateContent && <ReportPreview placeholders={placeholders} deeds={deeds} documents={documents} templateContent={templateContent} />}

        {/* Action Buttons */}
        <Card className="shadow-legal">
          <CardHeader>
            <CardTitle>Export Report</CardTitle>
            <CardDescription>Download or email the generated legal scrutiny report</CardDescription>
          </CardHeader>
          <CardContent className="flex gap-3">
            <Button onClick={handleSaveAsDraft} variant="outline" className="shadow-md transition-all duration-200 hover:shadow-lg">
              <Save className="mr-2 h-4 w-4" />
              Save as Draft
            </Button>
            <Button onClick={handleDownload} className="bg-primary hover:bg-primary/90 shadow-md transition-all duration-200 hover:shadow-lg">
              <Download className="mr-2 h-4 w-4" />
              Download as PDF/Word
            </Button>
          </CardContent>
        </Card>
      </main>

      {/* Footer */}
      <footer className="bg-muted py-6 mt-12 border-t border-border">
        <div className="container mx-auto px-4 text-center text-muted-foreground text-sm">
          <p>© 2025 Legal Scrutiny Report Generator. Professional Document Management System.</p>
        </div>
      </footer>
    </div>;
};
export default Index;