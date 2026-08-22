import * as React from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import AddIcon from "@mui/icons-material/Add";
import Stack from "@mui/material/Stack";
import { SessionList } from "../sessions/SessionList";
import { NewSessionDialog } from "../sessions/NewSessionDialog";

export function LeftNav(): React.ReactElement {
  const [newOpen, setNewOpen] = React.useState(false);

  return (
    <Box
      sx={{
        width: "100%",
        display: "flex",
        flexDirection: "column",
        background: "rgba(21,25,35,0.78)",
        border: "1px solid #2b3444",
        borderRadius: "18px",
        overflow: "hidden",
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", p: 2, pb: 1 }}>
        <Typography sx={{ fontWeight: 700, fontSize: 13, color: "#8d99ad", letterSpacing: "0.04em" }}>
          会话
        </Typography>
        <Button
          size="small"
          startIcon={<AddIcon />}
          onClick={() => setNewOpen(true)}
          sx={{ textTransform: "none", borderRadius: "999px" }}
        >
          新建
        </Button>
      </Box>
      <Box sx={{ flexGrow: 1, minHeight: 0, overflowY: "auto", px: 1.5, pb: 1.5 }}>
        <SessionList />
      </Box>
      <Stack spacing={1} sx={{ p: 1.5, pt: 1, borderTop: "1px solid #2b3444" }}>
        <Typography sx={{ fontSize: 11, color: "#697589" }}>
          会话来自 CLI JSONL。扩展面板在右栏。
        </Typography>
      </Stack>
      <NewSessionDialog open={newOpen} onClose={() => setNewOpen(false)} />
    </Box>
  );
}
