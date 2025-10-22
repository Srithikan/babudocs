import { useEffect, useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Trash2, FileText } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import DeedCustomFields from "./DeedCustomFields";
import { useNavigate } from "react-router-dom";
import type { User } from "@supabase/supabase-js";
export interface Deed {
  id: string;
  deed_type: string;
  executed_by: string;
  in_favour_of: string;
  date: string;
  document_number: string;
  nature_of_doc: string;
  custom_fields?: Record<string, string> | any;
}

interface DeedTemplate {
  deed_type: string;
  preview_template: string | null;
  custom_placeholders?: Record<string, string> | any;
}

const DeedsTable = () => {
  const [deeds, setDeeds] = useState<Deed[]>([]);
  const [deedTemplates, setDeedTemplates] = useState<DeedTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const updateTimeouts = useRef<{ [key: string]: NodeJS.Timeout }>({});

  const navigate = useNavigate();
  const [currentUser, setCurrentUser] = useState<User | null>(null);

  useEffect(() => {
    loadDeeds();
    loadDeedTemplates();
    setupRealtimeSubscription();
    // Initialize auth state and subscribe to changes
    supabase.auth.getUser().then(({ data }) => setCurrentUser(data.user ?? null));
    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      setCurrentUser(session?.user ?? null);
    });
    return () => {
      authListener?.subscription?.unsubscribe();
    };
  }, []);
  const loadDeeds = async () => {
    const { data, error } = await supabase
      .from("deeds")
      .select("*")
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Error loading deeds:", error);
      toast.error("Failed to load deeds");
      return;
    }

    setDeeds(data || []);
    setLoading(false);
  };

  const loadDeedTemplates = async () => {
    const { data, error } = await supabase
      .from("deed_templates")
      .select("deed_type, preview_template, custom_placeholders")
      .order("deed_type");

    if (error) {
      console.error("Error loading deed templates:", error);
      return;
    }

    setDeedTemplates(data || []);
  };

  const setupRealtimeSubscription = () => {
    const channel = supabase
      .channel("deeds-changes")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "deeds",
        },
        (payload) => {
          if (payload.eventType === "INSERT") {
            setDeeds((prev) => [...prev, payload.new as Deed]);
          } else if (payload.eventType === "UPDATE") {
            setDeeds((prev) =>
              prev.map((deed) =>
                deed.id === payload.new.id ? (payload.new as Deed) : deed
              )
            );
          } else if (payload.eventType === "DELETE") {
            setDeeds((prev) => prev.filter((deed) => deed.id !== payload.old.id));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  };

  const handleAddDeed = async () => {
    // Get current user or use anonymous user ID
    const { data: { user } } = await supabase.auth.getUser();
    const userId = user?.id || '00000000-0000-0000-0000-000000000000';

    const newDeed = {
      deed_type: "",
      executed_by: "",
      in_favour_of: "",
      date: new Date().toISOString().split("T")[0],
      document_number: "",
      nature_of_doc: "",
      user_id: userId,
    };

    const { error } = await supabase.from("deeds").insert(newDeed);

    if (error) {
      console.error("Error adding deed:", error);
      toast.error(`Failed to add deed: ${error.message}`);
    }
  };
  const handleRemoveDeed = async (id: string) => {
    const { error } = await supabase.from("deeds").delete().eq("id", id);

    if (error) {
      console.error("Error removing deed:", error);
      toast.error("Failed to remove deed");
    }
  };

  const handleUpdateDeed = useCallback((id: string, field: keyof Deed, value: string | Record<string, string>) => {
    // Update local state immediately for responsive UI
    setDeeds((prev) =>
      prev.map((deed) =>
        deed.id === id ? { ...deed, [field]: value } : deed
      )
    );

    // Clear any existing timeout for this field
    const timeoutKey = `${id}-${field}`;
    if (updateTimeouts.current[timeoutKey]) {
      clearTimeout(updateTimeouts.current[timeoutKey]);
    }

    // Debounce the database update
    updateTimeouts.current[timeoutKey] = setTimeout(async () => {
      const { error } = await supabase
        .from("deeds")
        .update({ [field]: value })
        .eq("id", id);

      if (error) {
        console.error("Error updating deed:", error);
        toast.error("Failed to update deed");
      }
    }, 500); // Wait 500ms after user stops typing
  }, []);

  const handleCustomFieldChange = useCallback((deedId: string, fieldKey: string, value: string) => {
    // Update local state immediately
    setDeeds((prev) =>
      prev.map((deed) =>
        deed.id === deedId
          ? { ...deed, custom_fields: { ...(deed.custom_fields as Record<string, string> || {}), [fieldKey]: value } }
          : deed
      )
    );

    // Debounce the database update
    const timeoutKey = `${deedId}-custom_fields`;
    if (updateTimeouts.current[timeoutKey]) {
      clearTimeout(updateTimeouts.current[timeoutKey]);
    }

    updateTimeouts.current[timeoutKey] = setTimeout(async () => {
      // Get the updated deed's custom fields
      const deed = deeds.find(d => d.id === deedId);
      if (!deed) return;

      const updatedCustomFields = { ...(deed.custom_fields as Record<string, string> || {}), [fieldKey]: value };

      const { error } = await supabase
        .from("deeds")
        .update({ custom_fields: updatedCustomFields })
        .eq("id", deedId);

      if (error) {
        console.error("Error updating custom field:", error);
        toast.error("Failed to update custom field");
      }
    }, 500);
  }, [deeds]);

  const getPreviewTemplate = (deedType: string): string => {
    const template = deedTemplates.find((t) => t.deed_type === deedType);
    return template?.preview_template || "{deedType} executed by {executedBy} in favour of {inFavourOf}";
  };

  const generatePreview = (deed: Deed): string => {
    const template = getPreviewTemplate(deed.deed_type);
    return template
      .replace(/{deedType}/g, deed.deed_type)
      .replace(/{executedBy}/g, deed.executed_by)
      .replace(/{inFavourOf}/g, deed.in_favour_of)
      .replace(/{date}/g, deed.date)
      .replace(/{documentNumber}/g, deed.document_number)
      .replace(/{natureOfDoc}/g, deed.nature_of_doc);
  };

  const deedTypes = deedTemplates.map((t) => t.deed_type);

  return (
    <Card className="shadow-legal">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-legal-header">
          <FileText className="h-5 w-5 text-accent" />
          Description of Documents Scrutinized
        </CardTitle>
        <CardDescription>Add deeds dynamically - each will generate: "[Deed Type] executed by [Name] in favour of [Name]"</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="text-center py-8 text-muted-foreground">
            <p>Loading deeds...</p>
          </div>
        ) : deeds.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <p>No deeds added yet. Click "Add New Deed" to begin.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className="p-3 text-left text-sm font-semibold bg-muted">Sno</th>
                  <th className="p-3 text-left text-sm font-semibold bg-muted">Date</th>
                  <th className="p-3 text-left text-sm font-semibold bg-muted">D.No</th>
                  <th className="p-3 text-left text-sm font-semibold bg-muted">Particulars of Deed</th>
                  <th className="p-3 text-left text-sm font-semibold bg-muted">Nature of Doc</th>
                  <th className="p-3 text-center text-sm font-semibold bg-muted w-20">Action</th>
                </tr>
              </thead>
              <tbody>
                {deeds.map((deed, index) => (
                  <tr key={deed.id} className="border-b border-border hover:bg-muted/50 transition-colors">
                    <td className="p-3 text-sm font-medium">{index + 1}</td>
                    <td className="p-3">
                      <Input
                        type="date"
                        value={deed.date}
                        onChange={(e) => handleUpdateDeed(deed.id, "date", e.target.value)}
                        className="transition-all duration-200"
                      />
                    </td>
                    <td className="p-3">
                      <Input
                        value={deed.document_number}
                        onChange={(e) => handleUpdateDeed(deed.id, "document_number", e.target.value)}
                        placeholder="Document Number"
                        className="transition-all duration-200"
                      />
                    </td>
                    <td className="p-3">
                      <div className="space-y-3">
                        <Select value={deed.deed_type} onValueChange={(value) => handleUpdateDeed(deed.id, "deed_type", value)}>
                          <SelectTrigger className="transition-all duration-200">
                            <SelectValue placeholder="Select deed type" />
                          </SelectTrigger>
                          <SelectContent>
                            {deedTypes.map((type) => (
                              <SelectItem key={type} value={type}>
                                {type}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <div className="grid grid-cols-2 gap-2">
                          <Input
                            value={deed.executed_by}
                            onChange={(e) => handleUpdateDeed(deed.id, "executed_by", e.target.value)}
                            placeholder="Executed by"
                            className="transition-all duration-200"
                          />
                          <Input
                            value={deed.in_favour_of}
                            onChange={(e) => handleUpdateDeed(deed.id, "in_favour_of", e.target.value)}
                            placeholder="In favour of"
                            className="transition-all duration-200"
                          />
                        </div>
                        {deed.deed_type && deed.executed_by && deed.in_favour_of && (
                          <div className="p-2 bg-muted rounded text-sm">
                            <strong>Preview:</strong> {generatePreview(deed)}
                          </div>
                        )}
                        {deed.deed_type && (
                          <DeedCustomFields
                            customPlaceholders={deedTemplates.find(t => t.deed_type === deed.deed_type)?.custom_placeholders || {}}
                            customValues={deed.custom_fields || {}}
                            onCustomValueChange={(key, value) => handleCustomFieldChange(deed.id, key, value)}
                          />
                        )}
                      </div>
                    </td>
                    <td className="p-3">
                      <Input
                        value={deed.nature_of_doc}
                        onChange={(e) => handleUpdateDeed(deed.id, "nature_of_doc", e.target.value)}
                        placeholder="Nature of Document"
                        className="transition-all duration-200"
                      />
                    </td>
                    <td className="p-3 text-center">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemoveDeed(deed.id)}
                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Button
          onClick={handleAddDeed}
          className="w-full bg-primary hover:bg-primary/90 shadow-md transition-all duration-200 hover:shadow-lg"
        >
          <Plus className="mr-2 h-4 w-4" />
          Add New Deed
        </Button>
      </CardContent>
    </Card>
  );
};

export default DeedsTable;
