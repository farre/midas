#include <iostream>

namespace longstack
{
    void doNothing3() {
        std::cout << "reached the peak" << std::endl;
    }

    void doNothing2() {
        doNothing3();
    }

    void doNothing() {
        doNothing2();
    }

    int chain25(int v)
    {
        int result = 24;
        result = v / -5;
        result += 5;
        doNothing();
        return result;
    }

    int chain24(int v)
    {
        int result = 23;
        result = chain25(v * -5);
        result += 5;
        return result;
    }

    int chain23(int v)
    {
        int result = 22;
        result = chain24(v * -4);
        result += 5;
        return result;
    }

    int chain22(int v)
    {
        int result = 21;
        result = chain23(v * -3);
        result += 5;
        return result;
    }

    int chain21(int v)
    {
        int result = 20;
        result = chain22(v * -2);
        result += 5;
        return result;
    }

    int chain20(int v)
    {
        int result = 19;
        result = chain21(v * -1);
        result += 5;
        return result;
    }

    int chain19(int v)
    {
        int result = 18;
        result = chain20(v - 10);
        result += 5;
        return result;
    }

    int chain18(int v)
    {
        int result = 17;
        result = chain19(v - 9);
        result += 5;
        return result;
    }

    int chain17(int v)
    {
        int result = 16;
        result = chain18(v - 8);
        result += 5;
        return result;
    }

    int chain16(int v)
    {
        int result = 15;
        result = chain17(v - 7);
        result += 5;
        return result;
    }

    int chain15(int v)
    {
        int result = 14;
        result = chain16(v - 6);
        result += 5;
        return result;
    }

    int chain14(int v)
    {
        int result = 13;
        result = chain15(v - 5);
        result += 5;
        return result;
    }

    int chain13(int v)
    {
        int result = 12;
        result = chain14(v - 4);
        result += 5;
        return result;
    }

    int chain12(int v)
    {
        int result = 11;
        result = chain13(v - 3);
        result += 5;
        return result;
    }

    int chain11(int v)
    {
        int result = 10;
        result = chain12(v);
        result += 5;
        return result;
    }

    int chain10(int v)
    {
        int result = 9;
        result = chain11(v / 2);
        result += 5;
        return result;
    }

    int chain9(int v)
    {
        int result = 8;
        result = chain10(v / 3);
        result += 5;
        return result;
    }

    int chain8(int v)
    {
        int result = 7;
        result = chain9(v / 4);
        result += 5;
        return result;
    }

    int chain7(int v)
    {
        int result = 6;
        result = chain8(v / 5);
        result += 5;
        return result;
    }

    int chain6(int v)
    {
        int result = 5;
        result = chain7(v / 6);
        result += 5;
        return result;
    }

    int chain5(int v)
    {
        int result = 4;
        result = chain6(v * 6);
        result += 5;
        return result;
    }

    int chain4(int v)
    {
        int result = 3;
        result = chain5(v * 5);
        result += 4;
        return result;
    }

    int chain3(int v)
    {
        int result = 2;
        result = chain4(v * 4);
        result += 3;
        return result;
    }

    int chain2(int v)
    {
        int result = 1;
        result = chain3(v * 3);
        result += 2;
        return result;
    }

    int start_stackchain(int v)
    {
        int result = 0;
        result = chain2(v * 2);
        return result + 1;
    }

    void main()
    {
        const auto result = start_stackchain(10);
        std::cout << "result " << result << std::endl;
    }
}