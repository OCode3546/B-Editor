// Decompiles every function of the imported program to C.
// Usage (headless): -postScript DecompileAll.java <output.c> [maxFunctions]
//@category BinaryEditor

import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;

import java.io.File;
import java.io.FileWriter;
import java.io.PrintWriter;

public class DecompileAll extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length < 1) {
            throw new IllegalArgumentException("usage: DecompileAll.java <output.c> [maxFunctions]");
        }
        int max = args.length > 1 ? Integer.parseInt(args[1]) : 2000;
        DecompInterface ifc = new DecompInterface();
        ifc.openProgram(currentProgram);
        try (PrintWriter w = new PrintWriter(new FileWriter(new File(args[0])))) {
            w.println("// " + currentProgram.getName() + " | " + currentProgram.getLanguageID()
                + " | image base " + currentProgram.getImageBase());
            w.println();
            FunctionIterator it = currentProgram.getFunctionManager().getFunctions(true);
            int n = 0;
            while (it.hasNext() && !monitor.isCancelled()) {
                Function f = it.next();
                if (f.isExternal() || f.isThunk()) {
                    continue;
                }
                if (n++ >= max) {
                    w.println("// … stopped after " + max + " functions");
                    break;
                }
                w.println("// ---- " + f.getName() + " @ " + f.getEntryPoint() + " ----");
                DecompileResults r = ifc.decompileFunction(f, 60, monitor);
                if (r.decompileCompleted()) {
                    w.println(r.getDecompiledFunction().getC());
                } else {
                    w.println("/* decompilation failed: " + r.getErrorMessage() + " */");
                    w.println();
                }
            }
        } finally {
            ifc.dispose();
        }
    }
}
