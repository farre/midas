#pragma once
namespace structsrequests
{
    struct Struct
    {
        int i;
        float f;
        const char *name;
    };

    struct Bar
    {
        int j = 0;
        Struct *s;
    };

    struct Foo
    {
        const char *name;
        int k;
    };

    Struct variablesRequestTest(Struct s);
    void variablesRequestTestReference(Struct &s);
    int testSubChildUpdate(Bar *b);
    void variablesRequestTestPointer(Struct *s);
    void main();
} // namespace structsrequests
