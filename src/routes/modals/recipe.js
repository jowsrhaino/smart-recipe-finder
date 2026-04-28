import mongoose from "mongoose";

const ingredientSchema = new mongoose.Schema({
    name: { type: String, required: true },
    quantity: { type: Number, required: true },
    unit: { type: String, required: true },
    image: { type: String, default: "" }
});

const recipeSchema = new mongoose.Schema({
    title: { type: String, required: true },

    category: {
        type: String,
        required: true,
        trim: true
    },

    cuisine: {
        type: String,
        required: true,
        trim: true
    },

    baseServes: {
        type: Number,
        required: true
    },

    ingredients: [ingredientSchema],

    instructions: {
        type: String,
        required: true
    },

    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
    },
    image: {
        type: String,
        default: ""
    },
    youtube: {
        type: String,
        default: ""
    },
    status: {
        type: String,
        enum: ["pending", "approved", "rejected"],
        default: "approved"
    },
    submittedByName: {
        type: String,
        default: ""
    },
    submittedByEmail: {
        type: String,
        default: ""
    },
    submittedByRole: {
        type: String,
        enum: ["admin", "user"],
        default: "admin"
    },
    verificationNote: {
        type: String,
        default: ""
    },
    verificationMode: {
        type: String,
        enum: ["manual", "ai", "admin"],
        default: "manual"
    },
    verifiedAt: {
        type: Date
    },
    verifiedBy: {
        type: String,
        default: ""
    },
    aiReview: {
        decision: {
            type: String,
            enum: ["approve", "review", "reject", ""],
            default: ""
        },
        score: {
            type: Number,
            default: 0
        },
        summary: {
            type: String,
            default: ""
        },
        issues: {
            type: [String],
            default: []
        },
        checkedAt: {
            type: Date
        }
    }

}, { timestamps: true });

const Recipe = mongoose.model("Recipe", recipeSchema);

export default Recipe;
