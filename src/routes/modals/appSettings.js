import mongoose from "mongoose";

const appSettingsSchema = new mongoose.Schema({
    key: {
        type: String,
        required: true,
        unique: true
    },
    value: {
        type: mongoose.Schema.Types.Mixed,
        required: true
    }
}, { timestamps: true });

const AppSettings = mongoose.model("AppSettings", appSettingsSchema);

export default AppSettings;
